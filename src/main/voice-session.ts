import { randomUUID } from 'node:crypto';
import { Row, VoiceStatus } from '../shared/types';
export interface AudioHost {
  start(id:string,device?:string):Promise<string>;
  answer(id:string,sdp:string):Promise<void>;
  stop(id?:string):Promise<void>;
}
interface Operation {id:string;thread:string;cancelled:boolean;native:boolean;ending?:Promise<void>;timer?:NodeJS.Timeout}
export class VoiceSession {
  status:VoiceStatus={phase:'idle'};
  private current:Operation|null=null;
  private transcriptComplete=false;
  private replyComplete=false;
  constructor(private audio:AudioHost,private request:(method:string,params:Record<string,any>)=>Promise<unknown>,private changed:(status:VoiceStatus)=>void){}
  private publish(update:Partial<VoiceStatus>){this.status={...this.status,...update};this.changed(this.status);}
  get running(){return this.current!==null;}
  async toggle(row:Row|undefined,connected:boolean,device='',voiceName=''){
    if(this.current){await this.stop();return;}
    if(!connected||!row||row.source==='comfyui'||!row.session_id||!row.settings_token){
      this.status={phase:'error',error:'Select a connected Codex agent to start voice.'};this.changed(this.status);return;
    }
    const op:Operation={id:randomUUID(),thread:row.session_id,cancelled:false,native:false};
    this.current=op;
    this.transcriptComplete=false;
    this.replyComplete=false;
    this.status={phase:'starting',voiceId:op.id,target:{id:row.id,sessionId:row.session_id,label:row.label},transcript:'',reply:''};this.changed(this.status);
    try{
      const sdp=await this.audio.start(op.id,device||undefined);
      if(this.current!==op||op.cancelled)return;
      op.native=true;
      op.timer=setTimeout(()=>{if(this.current===op)void this.end(op,'Voice did not connect. Please try again.');},20000);
      op.timer.unref();
      await this.request('voice-start',{id:row.id,session_id:row.session_id,voice_id:op.id,sdp,voice_name:voiceName});
      if(op.cancelled)await this.end(op);
    }catch(e){if(this.current===op&&!op.cancelled)await this.end(op,String((e as Error).message));}
  }
  audioState(id:string,state:'connecting'|'active'){
    if(this.current?.id!==id||this.current.cancelled)return;
    if(state==='active'){clearTimeout(this.current.timer);this.publish({phase:'active'});}
  }
  audioError(id:string,error:string){if(this.current?.id===id)void this.end(this.current,error);}
  event(message:{event:string;voice_id?:string;method?:string;params?:Record<string,any>}){
    const op=this.current,p=message.params??{};
    if(message.event!=='voice'||!op||message.voice_id!==op.id||(p.threadId&&p.threadId!==op.thread))return;
    if(message.method==='connection/closed'||message.method==='thread/closed'){
      void this.end(op,message.method==='thread/closed'?'Voice target was closed.':'Codex disconnected. Voice stopped.');return;
    }
    if(message.method==='thread/realtime/error'){void this.end(op,String(p.message||'Voice connection failed.'));return;}
    if(message.method==='thread/realtime/closed'){void this.end(op,op.cancelled?undefined:(p.reason&&p.reason!=='requested'?String(p.reason):undefined));return;}
    if(op.cancelled)return;
    if(message.method==='thread/realtime/sdp'){
      if(typeof p.sdp!=='string'||p.sdp.length>262144){void this.end(op,'Invalid voice connection response.');return;}
      void this.audio.answer(op.id,p.sdp).catch(e=>{if(this.current===op)void this.end(op,String(e.message));});
    }
    if(message.method==='thread/realtime/transcript/delta'||message.method==='thread/realtime/transcript/done'){
      const done=message.method.endsWith('/done');
      if(p.role==='user'){
        this.publish({transcript:(done?String(p.text??''):((this.transcriptComplete?'':this.status.transcript??'')+String(p.delta??''))).slice(-2000)});
        this.transcriptComplete=done;
      }else if(p.role==='assistant'){
        this.publish({reply:(done?String(p.text??''):((this.replyComplete?'':this.status.reply??'')+String(p.delta??''))).slice(-4000)});
        this.replyComplete=done;
      }
    }
  }
  async stop(){if(this.current)await this.end(this.current);}
  disconnect(error='Codex disconnected. Voice stopped.') {if(this.current)void this.end(this.current,error);}
  private end(op:Operation,error?:string):Promise<void>{
    if(op.ending)return op.ending;
    op.cancelled=true;
    clearTimeout(op.timer);
    if(this.current===op)this.publish({phase:error?'error':'stopping',error});
    // Release media immediately; never wait for a backend round trip first.
    const stopped=this.audio.stop(op.id);
    op.ending=(async()=>{
      const results=await Promise.allSettled([stopped,op.native?this.request('voice-stop',{voice_id:op.id}):Promise.resolve()]);
      if(this.current!==op)return;
      this.current=null;
      const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult|undefined;
      const reason=error||(failure?String(failure.reason?.message||failure.reason):undefined);
      this.publish({phase:reason?'error':'idle',error:reason,voiceId:undefined});
    })();
    return op.ending;
  }
}
