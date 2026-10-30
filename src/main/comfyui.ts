import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ComfyConnection, ComfyStatus, Row } from '../shared/types';

const JSON_LIMIT=16*1024*1024, IMAGE_LIMIT=20*1024*1024;
export function connection(value:unknown):ComfyConnection {
  const v=value as Partial<ComfyConnection>;
  if(!v||typeof v.name!=='string'||!v.name.trim()||v.name.trim().length>60)throw Error('Enter a name of 1–60 characters.');
  let url:URL;
  try{url=new URL(String(v.url));}catch{throw Error('Enter a complete ComfyUI URL, such as http://127.0.0.1:8188.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Use an HTTP or HTTPS server URL without credentials, query parameters or a fragment.');
  return {id:typeof v.id==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(v.id)?v.id:randomUUID(),name:v.name.trim(),url:url.href.replace(/\/+$/,'')};
}
function endpoint(base:string,path:string){return base+'/'+path;}
async function bytes(url:string,limit:number,signal?:AbortSignal):Promise<Buffer>{
  const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(6000)]):AbortSignal.timeout(6000),redirect:'error'});
  if(!response.ok){await response.body?.cancel();throw Error(`HTTP ${response.status}`);}
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Response too large');}
  const parts:Buffer[]=[];let size=0;
  if(response.body)for await(const part of response.body as any){size+=part.length;if(size>limit){await response.body.cancel().catch(()=>{});throw Error('Response too large');}parts.push(Buffer.from(part));}
  return Buffer.concat(parts);
}
async function json(url:string,signal?:AbortSignal){return JSON.parse((await bytes(url,JSON_LIMIT,signal)).toString('utf8'));}
export function validQueue(value:any):{running:any[];pending:any[]}{
  if(!value||!Array.isArray(value.queue_running)||!Array.isArray(value.queue_pending))throw Error('This address did not return a ComfyUI queue.');
  return {running:value.queue_running,pending:value.queue_pending};
}
function historyEntries(history:any):any[]{
  if(!history||typeof history!=='object'||Array.isArray(history))throw Error('Invalid ComfyUI history response');
  // /history preserves completion order; queue numbers can be negative for front-of-queue jobs.
  return Object.entries(history).map(([id,item]:[string,any])=>({...item,id})).reverse();
}
function outcome(item:any):string {
  const messages=Array.isArray(item?.status?.messages)?item.status.messages:[];
  if(messages.some((m:any)=>m?.[0]==='execution_interrupted'))return 'Cancelled';
  if(item?.status?.status_str==='error')return 'Generation failed';
  return item?.status?.completed?'Finished':'Idle';
}
function outputImage(items:any[]):{key:string;filename:string;subfolder:string;type:string;promptId:string}|undefined {
  for(const item of items){
    if(outcome(item)!=='Finished')continue;
    const outputs=Object.values(item.outputs??{}).reverse() as any[];
    const images=outputs.flatMap(output=>Array.isArray(output?.images)?[...output.images].reverse():[]);
    // Prefer saved outputs across all nodes; temporary PreviewImage output is a fallback.
    const candidates=[...images.filter((x:any)=>x?.type==='output'),...images.filter((x:any)=>x?.type!=='output')];
    const image=candidates.find((x:any)=>typeof x?.filename==='string'&&/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(x.filename));
    if(image){const result={filename:image.filename,subfolder:String(image.subfolder??''),type:image.type==='temp'?'temp':'output',promptId:item.id};return {...result,key:JSON.stringify(result)};}
  }
}
interface Runtime { config:ComfyConnection; row:Row; abort:AbortController; busy:boolean; nextPoll:number; helperCheck:number; imageKey:string; failedImageKey:string; imageRetry:number; historyAt:number; history:any[] }
export class ComfyMonitor {
  private instances=new Map<string,Runtime>();
  private stopped=false;
  constructor(private changed:()=>void=()=>{},private now:()=>number=Date.now){}
  configure(configs:ComfyConnection[]){
    for(const [id,state] of this.instances)if(!configs.some(c=>c.id===id&&c.url===state.config.url)){state.abort.abort();this.instances.delete(id);}
    for(const config of configs){
      const existing=this.instances.get(config.id);
      if(existing){existing.config=config;existing.row.label=config.name;continue;}
      const id='comfy:'+config.id;
      this.instances.set(config.id,{config,row:{id,session_id:id,label:config.name,source:'comfyui',state:'offline',reason:'Connecting',detail:'',project:config.url,actions:['focus'],control_token:'-',review:'',control_hint:'ComfyUI monitoring',comfy:{connected:false,url:config.url,running:0,pending:0,promptId:'',node:'',helper:false}},abort:new AbortController(),busy:false,nextPoll:0,helperCheck:0,imageKey:'',failedImageKey:'',imageRetry:0,historyAt:0,history:[]});
    }
    this.changed();
  }
  configs(){return [...this.instances.values()].map(s=>({...s.config}));}
  rows(){return [...this.instances.values()].map(s=>s.row);}
  url(id:string){return this.instances.get(id.replace(/^comfy:/,''))?.config.url;}
  async test(value:unknown){const c=connection(value);const q=validQueue(await json(endpoint(c.url,'queue')));return `Connected · ${q.running.length} running · ${q.pending.length} queued`;}
  async tick(){await Promise.all([...this.instances.values()].map(s=>this.poll(s)));}
  close(){this.stopped=true;for(const s of this.instances.values())s.abort.abort();}
  private async poll(s:Runtime){
    if(this.stopped||s.busy||this.now()<s.nextPoll)return;
    s.busy=true;
    const now=this.now(),base=s.config.url,signal=s.abort.signal;
    try{
      const queue=validQueue(await json(endpoint(base,'queue'),signal));
      const previous=s.row.comfy!,promptId=String(queue.running[0]?.[1]??'');
      const status:ComfyStatus={...previous,connected:true,running:queue.running.length,pending:queue.pending.length,promptId,node:'',progress:undefined};
      // A helper supplies browser-originated progress without taking over its WebSocket/client ID.
      if(status.helper||now>=s.helperCheck){
        try{
          const h=await json(endpoint(base,'pulsar-deck/status'),signal);
          if(h?.version!==1)throw Error('Unsupported progress helper');
          status.helper=true;
          if(promptId&&h.prompt_id===promptId){
            status.node=typeof h.node==='string'?h.node.slice(0,100):'';
            if(Number.isFinite(h.value)&&Number.isFinite(h.max)&&h.max>1&&h.value>=0&&h.value<=h.max)status.progress={value:h.value,max:h.max};
          }
        }catch{status.helper=false;s.helperCheck=now+30000;}
      }
      const queueChanged=previous.promptId!==promptId||previous.running!==status.running||previous.pending!==status.pending;
      if(!s.historyAt||queueChanged||now-s.historyAt>=5000){
        try{s.history=historyEntries(await json(endpoint(base,'history?max_items=40'),signal));s.historyAt=now;if(status.imageError?.startsWith('History'))status.imageError='';}
        catch{status.imageError='History unavailable; queue monitoring is still connected.';}
      }
      const terminal=s.history[0],lastOutcome=outcome(terminal);
      const image=outputImage(s.history);
      if(image&&image.key!==s.imageKey&&(image.key!==s.failedImageKey||now>=s.imageRetry)){
        try{
          const query=new URLSearchParams({filename:image.filename,subfolder:image.subfolder,type:image.type});
          const source=await bytes(endpoint(base,'view?'+query),IMAGE_LIMIT,signal);
          const png=await sharp(source,{limitInputPixels:40000000,animated:false}).rotate().resize(480,320,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
          status.latest={image:'data:image/png;base64,'+png.toString('base64'),filename:image.filename,promptId:image.promptId};
          s.imageKey=image.key;s.failedImageKey='';status.imageError='';
        }catch{s.failedImageKey=image.key;s.imageRetry=now+30000;status.imageError='Latest image unavailable; the previous image is retained.';}
      }
      const reason=status.running?'Generating':status.pending?'Queued':terminal?lastOutcome:'Idle';
      const state=status.running?'running':status.pending?'queued':lastOutcome==='Generation failed'?'error':'idle';
      const stage=status.progress?`${status.node||'Sampling'} · ${status.progress.value}/${status.progress.max} steps`:status.node||reason;
      s.row={...s.row,state,reason,detail:`${stage}\n${status.pending} queued`,review:`${reason}\n${stage}\n${status.pending} queued\n${status.imageError||''}`,comfy:status,control_hint:status.helper?'Live node progress connected':'Queue and image monitoring. Install the optional progress helper for node/step progress.'};
      s.nextPoll=this.now()+1000;
    }catch(e){
      if(!signal.aborted){s.row={...s.row,state:'offline',reason:'Offline',detail:'Cannot connect to ComfyUI',review:String((e as Error).message),comfy:{...s.row.comfy!,connected:false,running:0,pending:0,promptId:'',node:'',progress:undefined}};s.nextPoll=this.now()+5000;}
    }finally{
      s.busy=false;
      if(!signal.aborted&&!this.stopped)this.changed();
    }
  }
}
