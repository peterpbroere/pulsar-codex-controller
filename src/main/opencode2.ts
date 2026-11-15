import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { OpenCodeStatus, Row } from '../shared/types';

export interface OpenCode2Connection {
  url:string; port:number; pid:number; version:string; authorization:string; executablePath:string;
  tabFile?:string; hasClient?:boolean;
}
interface Session {
  id:string; parentID?:string; title?:string; projectID?:string; location?:{directory?:string}; model?:{id?:string;providerID?:string;variant?:string};
  time?:{created?:string|number;updated?:string|number;busy?:string|number;idle?:string|number;archived?:string|number};
  outcome?:string;
}
interface Permission { id:string; sessionID:string; action:string; resources?:string[]; metadata?:Record<string,unknown>; message?:string }
interface State {
  connection:OpenCode2Connection; connected:boolean; sessions:Map<string,Session>; active:Set<string>; seen:Set<string>;
  pending:Map<string,Permission>; errors:Map<string,string>; abort:AbortController; streaming:boolean; stopped:boolean;
}
const asTime=(value:unknown)=>typeof value==='number'?value:typeof value==='string'?Date.parse(value)||0:0;
const text=(value:unknown)=>typeof value==='string'?value:'';
export function readTabSessions(file:string):string[]{
  try{
    const root=JSON.parse(readFileSync(file,'utf8'));
    const ids:string[]=[];
    const add=(value:any)=>{for(const tab of Array.isArray(value?.tabs)?value.tabs:[])if(typeof tab?.sessionID==='string')ids.push(tab.sessionID);};
    add(root?.global);
    // cwd is keyed by absolute working directory; each entry owns a tabs array.
    for(const value of Object.values(root?.cwd??{}) as any[])add(value);
    return ids;
  }catch{return [];}
}

/** OpenCode 2.2.6 monitor. History is never used to decide row visibility. */
export class ModernOpenCodeMonitor {
  private states=new Map<number,State>(); private stopped=false;
  private polling=false;
  private textListener?:(sessionID:string,partId:string,text:string)=>void;
  private activityListener?:(sessionID:string,kind:'tool'|'ask'|'error',detail?:string)=>void;
  constructor(private connection:OpenCode2Connection,private changed:()=>void=()=>{},private now:()=>number=Date.now,
    private readTabs:(file:string)=>string[]=readTabSessions) {
    this.stateFor(connection);
  }
  private stateFor(connection=this.connection):State {
    let s=this.states.get(connection.port);
    if(!s){s={connection,connected:false,sessions:new Map(),active:new Set(),seen:new Set(),pending:new Map(),errors:new Map(),abort:new AbortController(),streaming:false,stopped:false};this.states.set(connection.port,s);}
    s.connection=connection; return s;
  }
  setTextListener(fn:(sessionID:string,partId:string,text:string)=>void):void {this.textListener=fn;}
  setActivityListener(fn:(sessionID:string,kind:'tool'|'ask'|'error',detail?:string)=>void):void {this.activityListener=fn;}
  private headers(s:State):HeadersInit {return {authorization:s.connection.authorization,accept:'application/json','content-type':'application/json'};}
  private async api(s:State,path:string,init:RequestInit={}):Promise<any>{
    const response=await fetch(new URL(path,s.connection.url),{...init,redirect:'error',headers:{...this.headers(s),...(init.headers||{})},signal:AbortSignal.any([s.abort.signal,AbortSignal.timeout(5000)])});
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`OpenCode ${response.status}`);}
    const body=await response.text(); return body?JSON.parse(body):undefined;
  }
  async tick():Promise<void>{
    if(this.stopped||this.polling)return;
    this.polling=true;
    const s=this.stateFor();
    try{
      const info=await this.api(s,'/api/info');
      s.connection.version=text(info?.version)||s.connection.version;
      const [active,list]=await Promise.all([this.api(s,'/api/session/active'),this.api(s,'/api/session?limit=100&archived=false')]);
      s.active=new Set(Object.entries(active?.data??{}).filter(([,v]:any)=>v?.type==='running').map(([id])=>id));
      const byID=new Map<string,Session>();
      for(const session of Array.isArray(list?.data)?list.data:[])if(typeof session?.id==='string')byID.set(session.id,session);
      const known=new Set([...s.active,...s.seen]);
      if(s.connection.hasClient&&s.connection.tabFile)for(const id of this.readTabs(s.connection.tabFile))known.add(id);
      for(const id of known){
        let session=byID.get(id);
        if(!session){try{session=(await this.api(s,`/api/session/${encodeURIComponent(id)}`))?.data;}catch{}}
        if(session?.id===id)s.sessions.set(id,session);
      }
      // Child sessions and archived history are never exposed as open TUI rows.
      for(const [id,session] of s.sessions){
        if(session.parentID||session.time?.archived!==undefined&&session.time.archived!==null){
          s.sessions.delete(id);s.active.delete(id);s.seen.delete(id);
          for(const [pid,p] of s.pending)if(p.sessionID===id)s.pending.delete(pid);
        }
      }
      // Permissions are fetched only for visible candidates and retain exact request IDs.
      for(const id of known){
        try{
          const result=await this.api(s,`/api/session/${encodeURIComponent(id)}/permission`);
          for(const [pid,p] of s.pending)if(p.sessionID===id)s.pending.delete(pid);
          for(const p of Array.isArray(result?.data)?result.data:[])if(p?.sessionID===id&&typeof p.id==='string')s.pending.set(p.id,p);
        }catch{/* retain a last-known pending request during transient failures */}
      }
      s.connected=true;
    }catch{ s.connected=false; }
    finally{this.polling=false;}
    void this.stream(s); this.changed();
  }
  private async stream(s:State):Promise<void>{
    if(s.streaming||s.stopped||this.stopped)return;s.streaming=true;
    try{
      const response=await fetch(new URL('/api/event',s.connection.url),{headers:{...this.headers(s),accept:'text/event-stream'},redirect:'error',signal:s.abort.signal});
      if(!response.ok||!response.body)throw Error('SSE unavailable');
      s.connected=true; const reader=response.body.getReader(),decoder=new TextDecoder(); let buffer='';
      while(!s.stopped&&!this.stopped){
        const {done,value}=await reader.read();if(done)break;
        buffer+=decoder.decode(value,{stream:true});let split;
        while((split=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,split).replace(/\r/g,'');buffer=buffer.slice(split+2);
          const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(!data)continue;
          try{const event=JSON.parse(data);this.event(s,event);}catch{/* ignore malformed frames */}
        }
      }
    }catch{if(!s.stopped&&!this.stopped)s.connected=false;}
    finally{s.streaming=false;this.changed();}
  }
  private event(s:State,event:any):void{
    if(!event||typeof event.type!=='string')return;
    const data=event.data??{};
    if(event.type==='server.connected')return;
    const sid=text(data.sessionID)||text(data.info?.sessionID)||text(data.info?.id);
    if(sid)s.seen.add(sid);
    if(event.type==='permission.asked'&&typeof data.id==='string'&&sid)s.pending.set(data.id,{...data,sessionID:sid});
    if(event.type==='permission.replied'&&typeof data.requestID==='string')s.pending.delete(data.requestID);
    if(event.type==='session.idle'&&sid)s.active.delete(sid);
    if((event.type==='session.busy'||event.type==='session.status')&&sid)s.active.add(sid);
    // Do not forward raw deltas: v2 parts can contain user text and tool output.
    if(event.type==='session.error'&&sid){const message=text(data.error?.message)||'Session error';s.errors.set(sid,message);this.activityListener?.(sid,'error',message);}
    this.changed();
  }
  rows():Row[]{
    const s=this.stateFor(),c=s.connection,ids=new Set([...s.active,...s.seen]);
    if(c.hasClient&&c.tabFile)for(const id of this.readTabs(c.tabFile))ids.add(id);
    const rows:Row[]=[];
    for(const id of ids){const session=s.sessions.get(id);if(!session)continue;
      const pending=s.connected?[...s.pending.values()].find(p=>p.sessionID===id):undefined,directory=text(session.location?.directory),title=text(session.title);
      const busy=s.active.has(id),error=s.errors.get(id);let state='idle',reason='Open',detail='';
      if(!s.connected){state='offline';reason='Offline';detail='Cannot reach OpenCode';}
      else if(pending){state='waiting';reason='Approval needed';detail='';}
      else if(error){state='error';reason='Error';detail=error;}
      else if(busy){state='running';reason='Working';detail='Working…';}
      const model=session.model?.id?`${session.model.providerID??''}/${session.model.id}`.replace(/^\//,''):undefined;
      const opencode:OpenCodeStatus={connected:s.connected,url:c.url,port:c.port,version:c.version,model,modelVariant:session.model?.variant};
      rows.push({id:`oc:${c.port}:${id}`,session_id:id,label:title||basename(directory)||`Session ${id.slice(-6)}`,title:title||undefined,state,reason,detail,project:directory,
        actions:s.connected?(pending?['approve','reject','focus']:busy?['stop','focus']:['continue','focus']):['focus'],
        control_token:pending?.id??`ses:${c.port}:${id}`,review:pending?`${pending.action||'Permission'} request\n${(pending.resources??[]).slice(0,2).join('\n')}${pending.message?`\n${pending.message}`:''}`:detail,
        control_hint:`OpenCode ${c.version} · ${c.url}`,source:'opencode',opencode});
    }
    return rows.sort((a,b)=>a.session_id.localeCompare(b.session_id));
  }
  private selected(rowId:string,token?:string):{s:State;sessionID:string;session:Session}{
    const m=/^oc:(\d+):(.+)$/.exec(rowId);if(!m)throw Error('Unknown OpenCode entry.');
    const s=this.states.get(Number(m[1]));if(!s||!s.connected)throw Error('OpenCode server is offline.');
    const session=s.sessions.get(m[2]);if(!session)throw Error('That OpenCode session is gone.');
    if(token!==undefined&&token!==`ses:${s.connection.port}:${m[2]}`&&!([...s.pending.values()].some(p=>p.sessionID===m[2]&&p.id===token)))throw Error('That selection is stale.');
    return {s,sessionID:m[2],session};
  }
  async action(rowId:string,verb:string,token:string):Promise<void>{
    const {s,sessionID}=this.selected(rowId,token);
    if(verb==='focus'){
      if(!/^[A-Za-z0-9_-]+$/.test(sessionID))throw Error('Invalid OpenCode session identifier.');
      const env={...process.env};
      const basic=/^Basic\s+(.+)$/i.exec(s.connection.authorization);
      if(basic){try{const credentials=Buffer.from(basic[1],'base64').toString('utf8');const colon=credentials.indexOf(':');if(colon>=0)env.OPENCODE_PASSWORD=credentials.slice(colon+1);}catch{}}
      if(s.connection.tabFile&&isAbsolute(s.connection.tabFile)){
        const stateRoot=resolve(s.connection.tabFile,'../../../../');
        env.XDG_STATE_HOME=stateRoot;env.XDG_CONFIG_HOME=resolve(stateRoot,'../config');
        env.XDG_DATA_HOME=resolve(stateRoot,existsSync(resolve(stateRoot,'../data'))?'../data':'../share');env.XDG_CACHE_HOME=resolve(stateRoot,'../cache');
        env.OPENCODE_CONFIG_DIR=resolve(env.XDG_CONFIG_HOME,'opencode');
      }
      // The v2 CLI's root TUI accepts the server and session directly. Open a
      // visible shell so the TUI remains interactive; no secret appears in args.
      const command=`start "Pulsar OpenCode" cmd.exe /k ""${s.connection.executablePath}" --server ${s.connection.url} --session ${sessionID}"`;
      spawn('cmd.exe',['/d','/s','/c',command],{detached:true,stdio:'ignore',windowsHide:false,env}).unref();return;
    }
    if(verb==='approve'||verb==='reject'){
      const p=[...s.pending.values()].find(x=>x.sessionID===sessionID&&x.id===token);if(!p)throw Error('No pending request. It may have been resolved already.');
      await this.api(s,`/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(p.id)}/reply`,{method:'POST',body:JSON.stringify({decision:verb==='approve'?'once':'reject'})});s.pending.delete(p.id);
    }else if(verb==='stop')await this.api(s,`/api/session/${encodeURIComponent(sessionID)}/interrupt`,{method:'POST'});
    else if(verb==='continue')await this.sendPrompt(rowId,'Continue');
    else throw Error('Unsupported action.');this.changed();
  }
  async sendPrompt(rowId:string,prompt:string):Promise<void>{const {s,sessionID}=this.selected(rowId);await this.api(s,`/api/session/${encodeURIComponent(sessionID)}/prompt`,{method:'POST',body:JSON.stringify({text:prompt,metadata:{}})});this.changed();}
  close():void{if(this.stopped)return;this.stopped=true;for(const s of this.states.values()){s.stopped=true;s.abort.abort();}this.states.clear();}
}
