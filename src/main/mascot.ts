import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Row, Snapshot } from '../shared/types';

export const MASCOT_CHOICES = ['cat', 'owl', 'off'] as const;
export type MascotChoice = typeof MASCOT_CHOICES[number];
export type MascotState = 'idle' | 'working' | 'approval' | 'done' | 'error';
const STATES: MascotState[] = ['idle','working','approval','done','error'];
export const isMascotChoice = (value:unknown): value is MascotChoice => MASCOT_CHOICES.includes(value as MascotChoice);
type Clip = { images:string[]; delayMs:number[] };
export interface MascotFrame { choice:Exclude<MascotChoice,'off'>; state:MascotState; index:number; image:string }

/** Cosmetic state only: never changes agent state, permissions or approval tokens. */
export class MascotPlayer {
  private previous = new Map<string,string>();
  private finished = new Map<string,number>();
  private phaseKey = '';
  private phaseStart = 0;
  constructor(private readonly clips:Record<string,Record<MascotState,Clip>>) {}
  static async load(root:string):Promise<MascotPlayer> {
    const base=join(root,'assets/mascots/v1');
    const manifest=JSON.parse(readFileSync(join(base,'manifest.json'),'utf8'));
    const clips:Record<string,Record<MascotState,Clip>>={};
    for(const name of ['cat','owl']){
      clips[name]={} as Record<MascotState,Clip>;
      for(const state of STATES){
        const spec=manifest.mascots[name][state];
        if(!Number.isInteger(spec.frames)||spec.frames<1||spec.frames>24||spec.delayMs.length!==spec.frames||spec.delayMs.some((ms:number)=>!Number.isFinite(ms)||ms<100))throw Error('Invalid mascot animation manifest');
        const images=await Promise.all(Array.from({length:spec.frames},async(_,i)=>{
          const png=await sharp(readFileSync(join(base,name,state,`${i}.png`))).resize(48,48,{kernel:'nearest'}).png().toBuffer();
          return 'data:image/png;base64,'+png.toString('base64');
        }));
        clips[name][state]={images,delayMs:spec.delayMs};
      }
    }
    return new MascotPlayer(clips);
  }
  observe(snapshot:Snapshot,now=Date.now()) {
    if(!snapshot.connected){this.previous.clear();this.finished.clear();return;}
    const present=new Set<string>();
    for(const row of snapshot.rows){
      const id=row.session_id;present.add(id);
      const before=this.previous.get(id);
      if(row.state==='idle'&&(before==='running'||before==='waiting')&&!/interrupt|cancel|error/i.test(row.reason))this.finished.set(id,now+5000);
      if(row.state!=='idle')this.finished.delete(id);
      this.previous.set(id,row.state);
    }
    for(const id of this.previous.keys())if(!present.has(id)){this.previous.delete(id);this.finished.delete(id);}
  }
  frame(choice:MascotChoice,row?:Row,connected=true,now=Date.now()):MascotFrame|null {
    if(choice==='off'){this.phaseKey='';return null;}
    const state:MascotState=!connected||!row?'idle':row.state==='waiting'?'approval':row.state==='error'?'error':row.state==='running'?'working':(this.finished.get(row.session_id)??0)>now?'done':'idle';
    const key=`${choice}:${row?.session_id??''}:${state}`;
    if(key!==this.phaseKey){this.phaseKey=key;this.phaseStart=now;}
    const clip=this.clips[choice]?.[state];if(!clip)return null;
    let elapsed=Math.max(0,now-this.phaseStart)%clip.delayMs.reduce((a,b)=>a+b,0),index=0;
    while(index<clip.delayMs.length-1&&elapsed>=clip.delayMs[index])elapsed-=clip.delayMs[index++];
    return {choice,state,index,image:clip.images[index]};
  }
}
