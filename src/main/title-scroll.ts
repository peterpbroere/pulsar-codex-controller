import sharp from 'sharp';

export interface TitleFrame { offset:number; scrolling:boolean }
export const TITLE_FONT={family:'Segoe UI,DejaVu Sans,sans-serif',size:17,weight:600};
const escapeMarkup=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));

export async function measureTitleWidth(label:string):Promise<number> {
  if(!label)return 0;
  const width=Math.max(8,Array.from(label).length*TITLE_FONT.size*2+8);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="68"><text x="4" y="34" font-family="${TITLE_FONT.family}" font-size="${TITLE_FONT.size}" font-weight="${TITLE_FONT.weight}" fill="white">${escapeMarkup(label)}</text></svg>`;
  const {info}=await sharp(Buffer.from(svg)).trim().png().toBuffer({resolveWithObject:true});
  return info.width;
}

/** Only the selected overview title moves. Existing animation ticks drive its position. */
export class TitleScroller {
  private widths=new Map<string,number>();
  private pending=new Map<string,Promise<number>>();
  private key='';
  private started=0;
  constructor(private measure:(label:string)=>Promise<number>=measureTitleWidth){}
  reset(){this.key='';}
  prepare(label:string):Promise<number> {
    const known=this.widths.get(label);if(known!==undefined)return Promise.resolve(known);
    const pending=this.pending.get(label);if(pending)return pending;
    const task=this.measure(label).catch(()=>0).then(width=>{
      this.widths.set(label,width);
      if(this.widths.size>64)this.widths.delete(this.widths.keys().next().value!);
      return width;
    }).finally(()=>this.pending.delete(label));
    this.pending.set(label,task);return task;
  }
  frame(id:string,label:string,now=Date.now(),viewport=222):TitleFrame {
    const key=JSON.stringify([id,label]);
    if(key!==this.key){this.key=key;this.started=now;}
    const width=this.widths.get(label);
    if(width===undefined){void this.prepare(label);return {offset:0,scrolling:false};}
    const overflow=Math.max(0,width-viewport+2);
    if(width<=viewport)return {offset:0,scrolling:false};
    const travel=overflow/24*1000,startPause=1800,endPause=1600;
    const elapsed=Math.max(0,now-this.started)%(startPause+travel+endPause+travel);
    const offset=elapsed<startPause?0:elapsed<startPause+travel?(elapsed-startPause)*24/1000:
      elapsed<startPause+travel+endPause?overflow:overflow-(elapsed-startPause-travel-endPause)*24/1000;
    return {offset:Math.round(Math.max(0,Math.min(overflow,offset))),scrolling:true};
  }
}
