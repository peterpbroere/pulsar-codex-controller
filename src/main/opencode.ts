import { execFile, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { OpenCodeStatus, Row } from '../shared/types';

const HEALTH_TIMEOUT=4000, POLL_TIMEOUT=6000, SESSION_LIMIT=12, RESCAN_MS=10000, POLL_MS=2000, RETRY_MS=2000, ERROR_KEEP_MS=120000, RECENT_MS=24*3600*1000;

export interface Listener { address:string; port:number; pid:number }
export function parseListeners(output:string, pids:Set<number>):Listener[] {
  const found=new Map<string,Listener>();
  for(const line of output.split(/\r?\n/)){
    const m=/\sTCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if(!m)continue;
    const address=m[1],port=Number(m[2]),pid=Number(m[3]);
    if(!pids.has(pid)||!port||port<1||port>65535)continue;
    const key=`${pid}:${port}`;
    if(!found.has(key))found.set(key,{address:address==='0.0.0.0'?'127.0.0.1':address,port,pid});
  }
  return [...found.values()];
}
export function attachArgs(url:string,sessionID:string):{file:string;args:string[]} {
  return {file:'cmd.exe',args:['/c','start','Pulsar OpenCode','cmd','/k','opencode','attach',url,'--session',sessionID]};
}
export function openCodeModelLabel(status?:OpenCodeStatus):string {
  if(!status?.model)return 'OPENCODE';
  const name=String(status.model).split('/').pop()||String(status.model);
  return status.modelVariant?`${name} · ${status.modelVariant}`:name;
}
export const OPENCODE_MODES=['Read-only','Auto','No prompts','YOLO / Full access'] as const;
export type OpenCodeMode=typeof OPENCODE_MODES[number];
interface Rule { permission:string; pattern:string; action:'allow'|'deny'|'ask' }
const anyPattern=(pattern:unknown)=>pattern==='*'||pattern==='**';
export function permissionRuleset(mode:string):Rule[] {
  switch(mode as OpenCodeMode){
    case 'Read-only':return [
      {permission:'edit',pattern:'*',action:'deny'},
      {permission:'bash',pattern:'*',action:'ask'},
      {permission:'external_directory',pattern:'*',action:'ask'},
      {permission:'external_directory',pattern:'**',action:'ask'}];
    case 'Auto':return [];
    case 'No prompts':return [
      {permission:'bash',pattern:'*',action:'allow'},
      {permission:'edit',pattern:'*',action:'allow'},
      {permission:'external_directory',pattern:'*',action:'deny'}];
    case 'YOLO / Full access':return [
      {permission:'bash',pattern:'*',action:'allow'},
      {permission:'edit',pattern:'*',action:'allow'},
      {permission:'external_directory',pattern:'*',action:'allow'},
      {permission:'external_directory',pattern:'**',action:'allow'}];
    default:throw Error('Unknown permission mode.');
  }
}
export function permissionMode(rules:unknown):string {
  if(!Array.isArray(rules)||!rules.length)return 'Auto';
  const rule=(name:string)=>rules.filter((r:any)=>r?.permission===name&&anyPattern(r?.pattern));
  const actions=(name:string)=>rule(name).map((r:any)=>r.action);
  const allowed=(name:string)=>actions(name).includes('allow');
  const denied=(name:string)=>actions(name).includes('deny');
  const asked=(name:string)=>actions(name).includes('ask');
  const full=allowed('bash')&&allowed('edit')&&allowed('external_directory')&&!asked('bash')&&!denied('bash');
  const noPrompts=allowed('bash')&&allowed('edit')&&denied('external_directory');
  const readOnly=denied('edit')&&asked('bash');
  if(full)return 'YOLO / Full access';
  if(noPrompts)return 'No prompts';
  if(readOnly)return 'Read-only';
  return 'Custom';
}
export interface Pending { id:string; sessionID:string; permission:string; patterns:string[]; resources:string[]; metadata:Record<string,unknown>; v2:boolean }
export function normalizePending(value:any):Pending|undefined {
  const id=typeof value?.id==='string'?value.id:'',sessionID=typeof value?.sessionID==='string'?value.sessionID:'';
  if(!id||!sessionID)return;
  const patterns=Array.isArray(value.patterns)?value.patterns.filter((p:any)=>typeof p==='string'):[];
  const resources=Array.isArray(value.resources)?value.resources.filter((p:any)=>typeof p==='string'):[];
  const permission=typeof value.permission==='string'?value.permission:typeof value.action==='string'?value.action:'';
  const metadata=value.metadata&&typeof value.metadata==='object'&&!Array.isArray(value.metadata)?value.metadata:{};
  return {id,sessionID,permission,patterns,resources,metadata,v2:typeof value.action==='string'||resources.length>0};
}
export function pendingPreview(pending:Pending):string {
  const lines=[`${pending.permission||'Permission'} request`];
  const scope=[...pending.patterns,...pending.resources].filter(p=>typeof p==='string'&&p).slice(0,2);
  if(scope.length)lines.push(...scope);
  const title=typeof pending.metadata?.title==='string'?pending.metadata.title:'';
  if(title)lines.push(title);
  return lines.join('\n').slice(0,400);
}
interface SessionState { id:string; title:string; directory:string; model?:{id:string;providerID:string;variant?:string}; updated:number; permission:unknown }
function childOrArchived(value:any):boolean {
  if(!value)return false;
  if(value.parentID)return true;
  return !!(value.time&&value.time.archived!==undefined&&value.time.archived!==null);
}
interface ServerState {
  url:string; port:number; pid:number; version:string; connected:boolean; failed:boolean; errorMessage:string;
  sessions:Map<string,SessionState>; statuses:Map<string,any>; pending:Map<string,Pending>;
  errors:Map<string,{message:string;at:number}>; activity:Map<string,string>;
  abort:AbortController; busy:boolean; nextPoll:number; streaming:boolean; sseRetry:number;
}
function signalFor(signal:AbortSignal|undefined,timeout:number=POLL_TIMEOUT):AbortSignal {
  return signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
}
async function request(base:string,path:string,init?:RequestInit,timeout?:number):Promise<unknown> {
  const response=await fetch(base+'/'+path,{...init,signal:signalFor(init?.signal??undefined,timeout)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`HTTP ${response.status} from OpenCode`);}
  const text=await response.text();
  return text?JSON.parse(text):undefined;
}
function post(base:string,path:string,body:unknown,signal?:AbortSignal):Promise<unknown> {
  return request(base,path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
}
function exec(command:string,args:string[]):Promise<string> {
  return new Promise((resolvePromise,reject)=>{
    execFile(command,args,{windowsHide:true,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):resolvePromise(String(stdout)));
  });
}
async function discoverListeners():Promise<Listener[]> {
  const [tasks,netstat]=await Promise.all([
    exec('tasklist',['/FI','IMAGENAME eq opencode.exe','/FO','CSV','/NH']),
    exec('netstat',['-ano']),
  ]);
  const pids=new Set<number>();
  for(const m of tasks.matchAll(/"opencode\.exe",\s*"(\d+)"/gi))pids.add(Number(m[1]));
  return parseListeners(netstat,pids);
}
export class OpenCodeMonitor {
  private servers=new Map<number,ServerState>();
  private stopped=false;
  private nextScan=0;
  constructor(private changed:()=>void=()=>{},private now:()=>number=Date.now,private discover:()=>Promise<Listener[]>=discoverListeners){}
  rows():Row[] {
    const out:Row[]=[];
    for(const server of [...this.servers.values()].sort((a,b)=>a.port-b.port)){
      // The server API exposes every recorded session across all projects; only
      // live or recently active ones belong on the deck. Dead history is clutter.
      const sessions=[...server.sessions.values()].filter(s=>{
        if([...server.pending.values()].some(p=>p.sessionID===s.id))return true;
        const status=server.statuses.get(s.id);
        if(status?.type==='busy'||status?.type==='retry')return true;
        return s.updated>0&&this.now()-s.updated<RECENT_MS;
      }).sort((a,b)=>b.updated-a.updated).slice(0,SESSION_LIMIT);
      for(const session of sessions)out.push(this.rowFor(server,session));
    }
    return this.dedupe(out);
  }
  // Every instance lists the shared database, so one session can appear on
  // several servers. Prefer the instance that actually holds its live state.
  private dedupe(rows:Row[]):Row[] {
    const best=new Map<string,Row>();
    for(const row of rows){
      const incumbent=best.get(row.session_id);
      if(!incumbent){best.set(row.session_id,row);continue;}
      const score=(r:Row)=>((r.opencode&&['running','waiting','error'].includes(r.state))?1:0);
      if(score(row)>score(incumbent))best.set(row.session_id,row);
    }
    return [...best.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  private rowFor(server:ServerState,session:SessionState):Row {
    const id=`oc:${server.port}:${session.id}`,pending=[...server.pending.values()].find(p=>p.sessionID===session.id);
    const status=server.statuses.get(session.id),error=server.errors.get(session.id);
    let state='idle',reason='Idle',detail='';
    if(!server.connected){
      // An outage outranks stale status knowledge; approvals against a dead server are pointless.
      state='offline';reason='Offline';detail='Cannot reach OpenCode';
    }else{
      if(error&&this.now()-error.at<ERROR_KEEP_MS){state='error';reason='Error';detail=error.message;}
      if(status?.type==='retry'){state='error';reason='Retrying';detail=String(status.message||`Attempt ${Number(status.attempt)+1}`);}
      if(status?.type==='busy'){state='running';reason='Working';detail=server.activity.get(session.id)||'Working…';}
      if(pending){state='waiting';reason='Approval needed';detail='';}
    }
    const actions:string[]=[];
    if(server.connected){
      if(pending){actions.push('approve','reject');}
      else if(status?.type==='busy')actions.push('stop');
      else actions.push('continue');
    }
    actions.push('focus');
    const model=session.model;
    const opencode:OpenCodeStatus={connected:server.connected,url:server.url,port:server.port,version:server.version,
      model:model?`${model.providerID}/${model.id}`:undefined,modelVariant:model?.variant};
    const label=session.title||basename(session.directory)||`Session ${session.id.slice(-6)}`;
    return {
      id,session_id:session.id,label,title:session.title||undefined,state,reason,detail,
      project:session.directory,actions,
      control_token:pending?pending.id:`ses:${session.id}@${server.port}`,
      review:pending?pendingPreview(pending):detail||'',
      control_hint:server.connected?`OpenCode ${server.version} · ${server.url}`:`OpenCode offline · ${server.url}${server.errorMessage?' · '+server.errorMessage:''}`,
      settings:{mode:permissionMode(session.permission)},
      settings_token:`perm:${server.port}:${session.id}`,
      source:'opencode',opencode,
    };
  }
  async tick():Promise<void> {
    if(this.stopped)return;
    if(this.now()>=this.nextScan){
      this.nextScan=this.now()+RESCAN_MS;
      await this.rescan();
    }
    await Promise.all([...this.servers.values()].map(server=>this.poll(server)));
    for(const server of this.servers.values())void this.stream(server);
  }
  private async rescan():Promise<void> {
    let listeners:Listener[]=[];
    try{listeners=await this.discover();}catch{return;}
    const live=new Set<number>();
    for(const listener of listeners){
      live.add(listener.port);
      if(this.servers.has(listener.port))continue;
      const url=`http://${listener.address}:${listener.port}`;
      try{
        const health=await request(url,'global/health',undefined,HEALTH_TIMEOUT) as any;
        if(health?.healthy!==true||typeof health.version!=='string')continue;
        this.servers.set(listener.port,this.blankServer(url,listener.port,listener.pid,health.version));
      }catch{}
    }
    for(const [port,server] of this.servers)if(!live.has(port)){server.abort.abort();this.servers.delete(port);}
  }
  private blankServer(url:string,port:number,pid:number,version:string):ServerState {
    return {url,port,pid,version,connected:false,failed:false,errorMessage:'',sessions:new Map(),statuses:new Map(),
      pending:new Map(),errors:new Map(),activity:new Map(),abort:new AbortController(),busy:false,nextPoll:0,streaming:false,sseRetry:0};
  }  private async poll(server:ServerState):Promise<void> {
    if(this.stopped||server.busy||this.now()<server.nextPoll)return;
    server.busy=true;
    const signal=server.abort.signal;
    try{
      const [sessions,statuses,pendings]=await Promise.all([
        request(server.url,'session',{signal}) as Promise<any[]>,
        request(server.url,'session/status',{signal}) as Promise<Record<string,any>>,
        request(server.url,'permission',{signal}).catch(()=>undefined) as Promise<unknown>,
      ]);
      const keep=new Set<string>();
      if(Array.isArray(sessions))for(const value of sessions){
        const id=typeof value?.id==='string'?value.id:'';
        if(!id||value.parentID)continue;
        if(value.time&&(value.time.archived!==undefined&&value.time.archived!==null))continue;
        keep.add(id);
        const previous=server.sessions.get(id);
        server.sessions.set(id,{id,
          title:typeof value.title==='string'?value.title:previous?.title??'',
          directory:typeof value.directory==='string'?value.directory:previous?.directory??'',
          model:this.validModel(value.model)??previous?.model,
          updated:Number(value.time?.updated)||previous?.updated||0,
          permission:value.permission??previous?.permission});
      }
      for(const id of [...server.sessions.keys()])if(!keep.has(id))server.sessions.delete(id);
      server.statuses=new Map(statuses&&typeof statuses==='object'&&!Array.isArray(statuses)?Object.entries(statuses).filter(([id])=>keep.has(id)):[]);
      const listed=Array.isArray(pendings)?pendings.map(normalizePending).filter((p):p is Pending=>!!p):undefined;
      // Legacy requests are listed globally; v2 requests are listed per session.
      // Ask every session that could be waiting: busy ones and those already holding a v2 request.
      const targets=new Set<string>();
      for(const id of keep)if(server.statuses.get(id)?.type==='busy')targets.add(id);
      for(const pending of server.pending.values())if(pending.v2)targets.add(pending.sessionID);
      const v2Lists=new Map<string,Pending[]|undefined>();
      await Promise.all([...targets].map(async id=>{
        try{
          const response=await request(server.url,`api/session/${encodeURIComponent(id)}/permission`,{signal}) as any;
          v2Lists.set(id,Array.isArray(response?.data)?(response.data as any[]).map(normalizePending).filter((p):p is Pending=>!!p):[]);
        }catch{v2Lists.set(id,undefined);}
      }));
      for(const [id,pending] of [...server.pending]){
        if(pending.v2){
          const listedNow=v2Lists.get(pending.sessionID);
          if(listedNow!==undefined&&!listedNow.some(p=>p.id===id))server.pending.delete(id);
          continue;
        }
        if(listed&&!listed.some(p=>p.id===id))server.pending.delete(id);
      }
      if(listed)for(const pending of listed)if(keep.has(pending.sessionID))server.pending.set(pending.id,pending);
      for(const list of v2Lists.values())if(list)for(const pending of list)if(keep.has(pending.sessionID))server.pending.set(pending.id,pending);
      server.connected=true;server.failed=false;server.errorMessage='';
      server.nextPoll=this.now()+POLL_MS;
    }catch(error){
      if(signal.aborted)return;
      server.connected=false;server.failed=true;server.errorMessage=String((error as Error).message);
      server.nextPoll=this.now()+5000;
      server.pending.clear();
    }finally{
      server.busy=false;
      if(!signal.aborted&&!this.stopped)this.changed();
    }
  }
  private validModel(value:any):{id:string;providerID:string;variant?:string}|undefined {
    if(!value||typeof value.id!=='string'||typeof value.providerID!=='string')return;
    return {id:value.id,providerID:value.providerID,variant:typeof value.variant==='string'?value.variant:undefined};
  }
  private async stream(server:ServerState):Promise<void> {
    if(server.streaming||this.stopped)return;
    server.streaming=true;
    const signal=server.abort.signal;
    try{
      while(!this.stopped&&!signal.aborted){
        if(this.now()<server.sseRetry){await new Promise(r=>setTimeout(r,400));continue;}
        let buffer='';
        try{
          const response=await fetch(server.url+'/global/event',{signal,headers:{accept:'text/event-stream'}});
          if(!response.ok||!response.body)throw Error(`HTTP ${response.status}`);
          server.connected=true;server.failed=false;server.errorMessage='';
          for await(const chunk of response.body as AsyncIterable<Uint8Array>){
            buffer+=Buffer.from(chunk).toString('utf8');
            let index:number;
            while((index=buffer.indexOf('\n'))>=0){
              const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
              if(!line.startsWith('data:'))continue;
              try{this.handle(server,JSON.parse(line.slice(5).trim()));}catch{}
            }
          }
          server.sseRetry=this.now()+RETRY_MS;
        }catch{
          if(signal.aborted||this.stopped)break;
          server.sseRetry=this.now()+RETRY_MS;
        }
      }
    }finally{server.streaming=false;}
  }
  private handle(server:ServerState,event:any):void {
    // Wire format: {directory, project, payload:{id, type, properties}} (verified on 1.19.2).
    const payload=event?.payload??event;
    const type=String(payload?.type??''),properties=payload?.properties??{};
    if(type==='session.updated'||type==='session.deleted'){
      const info=properties.info,id=typeof info?.id==='string'?info.id:typeof properties.sessionID==='string'?properties.sessionID:'';
      if(!id)return;
      // Events must respect the same filters as polling: no child/subagent or archived sessions.
      if(type==='session.deleted'||childOrArchived(info)){
        server.sessions.delete(id);server.statuses.delete(id);server.activity.delete(id);server.errors.delete(id);
        for(const [key,pending] of server.pending)if(pending.sessionID===id)server.pending.delete(key);
      }
      else{
        const previous=server.sessions.get(id);
        server.sessions.set(id,{id,
          title:typeof info.title==='string'?info.title:previous?.title??'',
          directory:typeof info.directory==='string'?info.directory:previous?.directory??'',
          model:this.validModel(info.model)??previous?.model,
          updated:Number(info.time?.updated)||previous?.updated||0,
          permission:info.permission??previous?.permission});
      }
    }
    else if(type==='permission.asked'||type==='permission.v2.asked'){
      const pending=normalizePending(properties);
      if(pending)server.pending.set(pending.id,pending);
    }
    else if(type==='permission.replied'||type==='permission.v2.replied'){
      const id=typeof properties.id==='string'?properties.id:typeof properties.requestID==='string'?properties.requestID:'';
      if(id)server.pending.delete(id);
    }
    else if(type==='session.error'){
      const sessionID=typeof properties.sessionID==='string'?properties.sessionID:typeof properties.info?.id==='string'?properties.info.id:'';
      if(sessionID){
        const raw=properties.error??properties.message;
        const message=typeof raw==='string'?raw:typeof raw?.message==='string'?raw.message:'Error reported';
        server.errors.set(sessionID,{message,at:this.now()});
        server.activity.delete(sessionID);
      }
    }
    else if(type==='message.part.updated'){
      const part=properties.part,sessionID=typeof part?.sessionID==='string'?part.sessionID:typeof properties.sessionID==='string'?properties.sessionID:'';
      if(!sessionID)return;
      server.errors.delete(sessionID);
      const tool=typeof part?.tool==='string'?part.tool:typeof part?.state?.title==='string'?part.state.title:'';
      if(part?.type==='tool'&&tool)server.activity.set(sessionID,`Tool: ${tool.slice(0,40)}`);
    }
    if(type!=='message.part.updated')this.changed();
  }
  async action(rowId:string,verb:string,token:string):Promise<void> {
    const match=/^oc:(\d+):(.+)$/.exec(rowId);
    if(!match)throw Error('Unknown OpenCode entry.');
    const port=Number(match[1]),sessionID=match[2],server=this.servers.get(port);
    if(!server)throw Error('That OpenCode server is no longer running.');
    if(verb==='focus'){
      const {file,args}=attachArgs(server.url,sessionID);
      spawn(file,args,{detached:true,stdio:'ignore',windowsHide:true}).unref();
      return;
    }
    const session=server.sessions.get(sessionID);
    if(!session)throw Error('That OpenCode session is gone.');
    if(verb==='approve'||verb==='reject'){
      const pending=[...server.pending.values()].find(p=>p.sessionID===sessionID);
      if(!pending)throw Error('No pending request. It may have been resolved already.');
      if(token!==pending.id)throw Error('That request has changed. Review the current request, then try again.');
      const reply=verb==='approve'?'once':'reject';
      if(pending.v2){
        await post(server.url,`api/session/${encodeURIComponent(pending.sessionID)}/permission/${encodeURIComponent(pending.id)}/reply`,{reply});
      }else{
        await post(server.url,`permission/${encodeURIComponent(pending.id)}/reply`,{reply});
      }
      server.pending.delete(pending.id);
      this.changed();
      return;
    }
    if(verb==='stop'){await post(server.url,`session/${encodeURIComponent(sessionID)}/abort`,{});this.changed();return;}
    if(verb==='continue'){
      await post(server.url,`session/${encodeURIComponent(sessionID)}/prompt_async`,{parts:[{type:'text',text:'Continue'}]});
      this.changed();return;
    }
    throw Error('Unsupported action.');
  }
  async setPermission(rowId:string,mode:string,token:string):Promise<void> {
    if(!(OPENCODE_MODES as readonly string[]).includes(mode))throw Error('Unknown permission mode.');
    const match=/^oc:(\d+):(.+)$/.exec(rowId);
    if(!match)throw Error('Unknown OpenCode entry.');
    const port=Number(match[1]),sessionID=match[2],server=this.servers.get(port);
    if(!server)throw Error('That OpenCode server is no longer running.');
    const session=server.sessions.get(sessionID);
    if(!session)throw Error('That OpenCode session is gone.');
    if(token!==`perm:${port}:${sessionID}`)throw Error('That selection is stale. Open the permission page again.');
    const ruleset=permissionRuleset(mode);
    const updated=await request(server.url,`session/${encodeURIComponent(sessionID)}`,{
      method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({permission:ruleset})}) as any;
    const applied=permissionMode(updated?.permission);
    if(applied!==mode)throw Error(`OpenCode reported '${applied}' instead of '${mode}'. Reopen the permission page.`);
    session.permission=updated.permission;
    this.changed();
  }
  close():void {
    this.stopped=true;
    for(const server of this.servers.values())server.abort.abort();
    this.servers.clear();
  }
}
