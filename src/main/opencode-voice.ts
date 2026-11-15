import { Row, VoiceStatus } from '../shared/types';

export interface SpeechConfig {
  ttsUrl:string; ttsVoice:string; sttUrl:string;
  ollamaUrl:string; summarizerModel:string;
  voiceStyle:'summaries'|'full';
}
export const DEFAULT_OLLAMA_URL='http://127.0.0.1:11434', DEFAULT_SUMMARIZER='gemma4:e2b-it-qat';
export function validateSpeechConfig(value:unknown):SpeechConfig {
  const v=(value??{}) as Record<string,unknown>;
  const url=(name:string,fallback=''):string => {
    const raw=v[name];
    if(raw===undefined||raw===null||raw==='')return fallback;
    if(typeof raw!=='string')throw Error(`The ${name} must be a URL.`);
    let parsed:URL;
    try{parsed=new URL(raw);}catch{throw Error(`The ${name} must be a complete URL, such as http://127.0.0.1:8915.`);}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error(`The ${name} must use HTTP or HTTPS without credentials.`);
    return parsed.origin+parsed.pathname.replace(/\/+$/,'');
  };
  const voice=v.ttsVoice;
  if(voice!==undefined&&voice!==null&&typeof voice!=='string')throw Error('The TTS voice must be a name.');
  const summarizerModel=v.summarizerModel;
  if(summarizerModel!==undefined&&summarizerModel!==null&&typeof summarizerModel!=='string')throw Error('The summarizer model must be a name.');
  const style=v.voiceStyle;
  if(style!==undefined&&style!=='summaries'&&style!=='full')throw Error("The voice style must be 'summaries' or 'full'.");
  return {
    ttsUrl:url('ttsUrl'),
    ttsVoice:typeof voice==='string'?voice.slice(0,120):'',
    sttUrl:url('sttUrl'),
    ollamaUrl:url('ollamaUrl',DEFAULT_OLLAMA_URL),
    summarizerModel:typeof summarizerModel==='string'&&summarizerModel?summarizerModel.slice(0,120):DEFAULT_SUMMARIZER,
    voiceStyle:style==='full'?'full':'summaries',
  };
}
export function completeSentences(text:string,offset:number):{sentences:string[];offset:number} {
  const sentences:string[]=[];
  let start=Math.max(0,offset);
  for(let i=start;i<text.length;i++){
    const ch=text[i];
    if(ch!=='.'&&ch!=='!'&&ch!=='?'&&ch!=='…'&&ch!=='\n')continue;
    let end=i+1;
    while(end<text.length&&'"\')]'.includes(text[end]))end++;
    if(end<text.length&&!/\s/.test(text[end]))continue;
    const segment=text.slice(start,end).trim();
    if(segment)sentences.push(segment);
    start=end;i=end-1;
  }
  return {sentences,offset:start};
}
export interface OpenCodeAudio {
  pttStart(voiceId:string,deviceId?:string):Promise<unknown>;
  pttStop(voiceId:string):Promise<string>;
  speak(voiceId:string,audioBase64:string):Promise<void>;
  speakCancel(voiceId:string):Promise<void>;
  stop(voiceId?:string):Promise<void>;
}
export interface OpenCodeVoiceDeps {
  audio:OpenCodeAudio;
  changed:(status:VoiceStatus)=>void;
  send:(rowId:string,text:string)=>Promise<void>;
  now:()=>number;
}
const WAV_BYTES_PER_SECOND=32000;
function wavDurationEstimate(audioBase64:string):number {
  const bytes=audioBase64.length*3/4;
  return Math.max(1,Math.round((bytes-44)/WAV_BYTES_PER_SECOND*1000));
}
async function synthesize(cfg:SpeechConfig,text:string):Promise<string> {
  const response=await fetch(cfg.ttsUrl+'/v1/audio/speech',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'chatterbox',input:text,voice:cfg.ttsVoice||'default_sample.wav',response_format:'wav'}),
    signal:AbortSignal.timeout(120000)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`Speech service returned HTTP ${response.status}.`);}
  const type=String(response.headers.get('content-type')??'');
  if(!type.startsWith('audio/'))throw Error('The speech service did not return audio.');
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length<100)throw Error('The speech service returned no usable audio.');
  return buffer.toString('base64');
}
export async function transcribe(cfg:SpeechConfig,wavBase64:string):Promise<string> {
  const form=new FormData();
  form.append('file',new Blob([Buffer.from(wavBase64,'base64')],{type:'audio/wav'}),'clip.wav');
  form.append('model','whisper');
  const response=await fetch(cfg.sttUrl+'/v1/audio/transcriptions',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`Speech-to-text returned HTTP ${response.status}.`);}
  const value=await response.json().catch(()=>undefined) as any;
  return typeof value?.text==='string'?value.text:'';
}
type Stage='recording'|'transcribing'|'speaking';
export function narration(tool:string):string {
  const t=String(tool).toLowerCase();
  if(t==='bash'||t==='shell'||t==='terminal'||t.includes('bash'))return 'Working in the terminal.';
  if(t==='edit'||t==='write'||t==='patch'||t.includes('edit')||t.includes('write'))return 'Editing files.';
  if(t==='read'||t==='glob'||t==='grep'||t==='list'||t==='ls'||t.includes('read')||t.includes('search'))return 'Looking through the files.';
  if(t==='webfetch'||t==='websearch'||t.includes('web'))return 'Checking the web.';
  if(t==='task'||t==='subtask'||t==='agent')return 'Delegating to a subagent.';
  return '';
}
async function summarize(cfg:SpeechConfig,reply:string):Promise<string> {
  const clipped=reply.slice(0,4000);
  const response=await fetch(cfg.ollamaUrl+'/api/generate',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:cfg.summarizerModel,stream:false,
      prompt:`A coding agent just finished a turn. Summarize for the user in at most two short spoken sentences: what it did and what it found or changed. Plain text only, no lists, no markdown, no command lines.\n\nTranscript:\n${clipped}`}),
    signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  const value=await response.json() as any;
  return typeof value?.response==='string'?value.response.replace(/\s+/g,' ').trim():'';
}
export class OpenCodeVoice {
  status:VoiceStatus={phase:'idle'};
  private opId?:string;
  private stage?:Stage;
  private rowId='';
  private sessionId='';
  private queue:string[]=[];
  private pumping=false;
  private endWhenDrained=false;
  private spokenReplies=false;
  private config:SpeechConfig={ttsUrl:'',ttsVoice:'',sttUrl:'',ollamaUrl:DEFAULT_OLLAMA_URL,summarizerModel:DEFAULT_SUMMARIZER,voiceStyle:'summaries'};
  constructor(private deps:OpenCodeVoiceDeps){}
  configure(config:SpeechConfig,spokenReplies=this.spokenReplies):void {
    this.config=config;
    this.spokenReplies=spokenReplies;
  }
  private publish(update:Partial<VoiceStatus>){this.status={...this.status,...update};this.deps.changed(this.status);}
  handles(voiceId:string):boolean { return this.opId===voiceId; }
  get busy():boolean { return this.opId!==undefined; }
  get targetSessionId():string { return this.sessionId; }
  audioState(voiceId:string,state:'connecting'|'active'):void {
    if(!this.handles(voiceId)||this.stage!=='recording')return;
    if(state==='active')this.publish({phase:'active'});
  }
  audioError(voiceId:string,message:string):void {
    if(!this.handles(voiceId))return;
    if(this.stage==='recording'||this.stage==='transcribing'){
      this.opId=undefined;this.stage=undefined;
      this.publish({phase:'error',error:message});
    }
  }
  private end(message?:string):void {
    const id=this.opId;
    if(id===undefined)return;
    this.opId=undefined;this.stage=undefined;this.queue=[];this.endWhenDrained=false;this.spokenOffsets.clear();this.replyParts.clear();this.lastNarration=null;this.sessionId='';
    if(message===undefined)this.publish({phase:'idle',target:undefined,speakingUntil:undefined,reply:undefined,transcript:undefined});
    else this.publish({phase:'error',error:message,speakingUntil:undefined});
    void this.deps.audio.speakCancel(id).then(()=>this.deps.audio.stop(id));
  }
  async toggle(row:Row|undefined,device=''):Promise<void> {
    if(this.opId){
      if(this.stage==='recording'){await this.finishTap();return;}
      this.end();return;
    }
    if(!row||row.source!=='opencode'||!row.id){this.publish({phase:'error',error:'Select an OpenCode session for voice.'});return;}
    if(!this.config.sttUrl){this.publish({phase:'error',error:'Configure a speech-to-text server first (Speech services on the PC).'});return;}
    const id=this.opId=`ocv-${Date.now().toString(36)}`;
    this.rowId=row.id;this.sessionId=row.session_id;this.stage='recording';
    this.spokenOffsets.clear();this.replyParts.clear();this.lastNarration=null;this.queue=[];this.endWhenDrained=false;this.finishedSeen=0;
    this.publish({phase:'starting',target:{id:row.id,sessionId:row.session_id,label:row.label},transcript:'',reply:'',error:undefined});
    try{
      await this.deps.audio.pttStart(id,device||undefined);
      if(this.opId!==id)return;
      this.publish({phase:'active'});
    }catch(error){
      if(this.opId===id){
        this.opId=undefined;this.stage=undefined;
        this.publish({phase:'error',error:String((error as Error).message)});
      }
    }
  }
  private async finishTap():Promise<void> {
    const id=this.opId;
    if(id===undefined||this.stage!=='recording')return;
    this.stage='transcribing';
    this.publish({phase:'stopping'});
    let wav:string;
    try{wav=await this.deps.audio.pttStop(id);}
    catch(error){
      this.opId=undefined;this.stage=undefined;
      this.publish({phase:'error',error:String((error as Error).message)});
      return;
    }
    if(this.opId!==id)return;
    let text='';
    try{text=await transcribe(this.config,wav);}
    catch(error){
      this.opId=undefined;this.stage=undefined;
      this.publish({phase:'error',error:String((error as Error).message)});
      return;
    }
    if(this.opId!==id)return;
    const clean=text.trim();
    if(!clean){this.opId=undefined;this.stage=undefined;this.publish({phase:'error',error:'Nothing recognizable was recorded. Try again.'});return;}
    this.publish({phase:'stopping',transcript:clean});
    try{await this.deps.send(this.rowId,clean);}
    catch(error){
      this.opId=undefined;this.stage=undefined;
      this.publish({phase:'error',error:String((error as Error).message)});
      return;
    }
    if(this.opId!==id)return;
    this.stage='speaking';this.spokenOffsets.clear();this.queue=[];this.finishedSeen=0;
    this.publish({phase:'active',transcript:clean,reply:''});
  }
  private spokenOffsets=new Map<string,number>();
  private replyParts=new Map<string,string>();
  private lastNarration:{kind:string;at:number}|null=null;
  private finishedSeen=0;
  observeText(sessionID:string,partId:string,text:string):void {
    if(this.opId===undefined||this.stage!=='speaking'||sessionID!==this.sessionId)return;
    if(this.config.voiceStyle!=='full'){this.replyParts.set(partId,text);return;}
    const offset=this.spokenOffsets.get(partId)??0;
    const {sentences,offset:next}=completeSentences(text,offset);
    this.spokenOffsets.set(partId,next);
    if(this.spokenOffsets.size>60)for(const key of [...this.spokenOffsets.keys()].slice(0,30))this.spokenOffsets.delete(key);
    if(sentences.length){this.queue.push(...sentences);void this.pump();}
  }
  announce(sessionID:string,kind:'tool'|'ask'|'error',detail=''):void {
    if(this.config.voiceStyle!=='summaries')return;
    if(this.opId===undefined||this.stage!=='speaking'||sessionID!==this.sessionId)return;
    if(!this.spokenReplies||!this.config.ttsUrl)return;
    const now=this.deps.now();
    const text=kind==='tool'?narration(detail):kind==='ask'?'Asking your permission.':'Hit a problem, retrying.';
    if(!text)return;
    if(this.lastNarration&&this.lastNarration.kind===text&&now-this.lastNarration.at<12000)return;
    this.lastNarration={kind:text,at:now};
    this.queue.push(text);
    void this.pump();
  }
  turnUpdate(state:'running'|'unknown'|'finished'|'gone'):void {
    if(this.opId===undefined||this.stage!=='speaking')return;
    if(state==='gone'){this.end('The OpenCode session closed.');return;}
    if(state==='unknown'){this.finishedSeen=0;return;}
    if(state==='running'){this.finishedSeen=0;return;}
    // Require two consecutive finished reports (poll cadence) so a single
    // status flap cannot end the exchange before the reply is done.
    this.finishedSeen++;
    if(this.finishedSeen<2)return;
    this.finishedSeen=0;
    if(this.config.voiceStyle==='full'){this.endWhenDrained=true;void this.pump();return;}
    void this.finishSummary();
  }
  private async finishSummary():Promise<void> {
    const id=this.opId;
    if(id===undefined||this.stage!=='speaking')return;
    const reply=[...this.replyParts.values()].join(' ').replace(/\s+/g,' ').trim();
    this.replyParts.clear();
    let summary='';
    if(reply)try{summary=await summarize(this.config,reply);}catch{}
    if(this.opId!==id||this.stage!=='speaking')return;
    this.queue.push(summary||'Turn finished.');
    this.endWhenDrained=true;
    void this.pump();
  }
  private async pump():Promise<void> {
    if(this.pumping||this.opId===undefined)return;
    this.pumping=true;
    const id:string=this.opId;
    try{
      while(this.opId===id&&this.stage==='speaking'&&this.queue.length){
        if(!this.spokenReplies||!this.config.ttsUrl){this.queue=[];break;}
        const sentence=this.queue.shift()!;
        this.publish({reply:sentence});
        try{
          const audioBase64=await synthesize(this.config,sentence);
          if(this.opId!==id||this.stage!=='speaking')break;
          this.publish({speakingUntil:this.deps.now()+wavDurationEstimate(audioBase64)});
          await this.deps.audio.speak(id,audioBase64);
          this.publish({speakingUntil:this.deps.now()});
        }catch(error){
          if(this.opId!==id||this.stage!=='speaking')break;
          this.publish({speakingUntil:this.deps.now(),error:`Speech playback failed: ${String((error as Error).message)}`});
          this.queue=[];
          break;
        }
      }
      if(this.opId===id&&this.stage==='speaking'&&this.endWhenDrained&&!this.queue.length)this.end();
    }finally{this.pumping=false;}
  }
  close():void {
    const id=this.opId;
    this.opId=undefined;this.stage=undefined;this.queue=[];this.sessionId='';
    this.spokenOffsets.clear();this.replyParts.clear();this.lastNarration=null;
    this.status={phase:'idle'};
    this.deps.changed(this.status);
    if(id!==undefined)void this.deps.audio.stop(id);
  }
}


