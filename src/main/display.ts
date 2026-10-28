import sharp from 'sharp';
import { Controller, MODES, modeLabel, modelLabel, effortLabel } from './controller';
const esc = (s: unknown) => String(s ?? '').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!));
const clip=(s:string,n:number)=>Array.from(s).length>n?Array.from(s).slice(0,n-1).join('')+'…':s;
export function wrap(s:string,width:number) {
  const result:string[]=[];
  for(const paragraph of s.split(/\r?\n/)){let line='';for(const word of paragraph.split(/\s+/)){
    if(line&&Array.from(line+' '+word).length>width){result.push(line);line='';}
    if(Array.from(word).length>width){if(line){result.push(line);line='';}const chars=Array.from(word);while(chars.length>width)result.push(chars.splice(0,width).join(''));line=chars.join('');}
    else line+=(line?' ':'')+word;
  }if(line)result.push(line);}return result;
}
export function displaySvg(c:Controller,mascotImage?:string):string {
  const row=c.row,selected=c.snapshot.rows.findIndex(r=>r.id===c.selected),waiting=row?.state==='waiting';
  const color=waiting?'#ffc76b':row?.state==='error'?'#ff8295':row?.state==='running'?'#8fbaff':'#7ed9bd';
  const text=(x:number,y:number,s:string,fill='#edf2f7',size=11,weight=400,anchor='start')=>`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`;
  let body='',top='',footer='';
  const buttons=[['1','APPROVE',c.canApprove],['2','OPEN PC',row?.actions.includes('focus')],['3','ATTENTION',c.attention.length>0]];
  for(let i=0;i<3;i++)footer+=`<rect x="${i*80+3}" y="114" width="74" height="18" rx="4" fill="${buttons[i][2]?'#203043':'#141f2b'}"/>`+text(i*80+8,126,String(buttons[i][0]),buttons[i][2]?'#7ed9bd':'#526275',8,600)+text(i*80+20,126,String(buttons[i][1]),buttons[i][2]?'#eef3f8':'#526275',8,600);
  if(c.page==='agent'){
    const configuration=row?`${clip(modelLabel(row,c.snapshot),20)} · ${effortLabel(row.settings?.effort)}`:'CODEX';
    top=`<svg x="9" y="0" width="150" height="18" overflow="hidden">${text(0,13,configuration,'#9eafc3',8,600)}</svg>`+text(231,13,`${Math.max(0,selected+1)} / ${c.snapshot.rows.length}   ·   ${c.attention.length} WAIT`,'#9cacc0',8,500,'end');
    if(row){body+=text(9,35,clip(row.label,24),'#fff',17,650)+`<circle cx="13" cy="49" r="3" fill="${color}"/>`+text(21,53,waiting?'NEEDS YOU':row.state==='running'?'WORKING':row.state==='error'?'ERROR':'READY',color,9,650)+text(231,53,modeLabel(row.settings),'#9cacc0',9,500,'end');
      const width=mascotImage?28:36;
      const lines=wrap((row.review||row.detail||row.reason||'Ready for your next instruction').replace(/^Command:\s*/,''),width);
      body+=`<svg x="9" y="58" width="${mascotImage?166:222}" height="42" overflow="hidden">`;
      lines.slice(0,3).forEach((line,i)=>{body+=text(0,11+i*13,clip(line,width),waiting?'#ffe1af':'#bbc9d8',10);});
      body+='</svg>';
      if(mascotImage)body+=`<image x="184" y="56" width="48" height="48" href="${esc(mascotImage)}"/>`;
      body+=text(9,108,lines.length>3?'Preview truncated · press knob for details':'TURN: agent    ·    PRESS: details','#697f95',8);
    }else {body+=text(10,44,'No agents yet','#fff',17,600)+text(10,65,mascotImage?'Start Codex and send':'Start Codex and send a prompt.','#a0b2c5',11)+(mascotImage?text(10,79,'a prompt.','#a0b2c5',11):'')+text(10,96,'Turn to browse · + settings','#697f95',9);
      if(mascotImage)body+=`<image x="184" y="51" width="48" height="48" href="${esc(mascotImage)}"/>`;
    }
  }else if(c.page==='details'){
    top=text(9,14,clip(row?.label||'Agent',27),'#d6e2ee',10,600)+text(231,14,'DETAILS','#7d91a7',8,500,'end');
    const lines=wrap(row?.review||row?.detail||row?.reason||'',37),offset=c.scroll%Math.max(1,lines.length);
    lines.slice(offset,offset+3).forEach((line,i)=>{body+=text(9,34+i*13,clip(line,37),'#ced9e5',10);});
    const start=Math.max(0,Math.min(c.cursor-1,c.menu.length-2));
    c.menu.slice(start,start+2).forEach((entry,i)=>{const active=start+i===c.cursor;body+=`<rect x="5" y="${75+i*17}" width="230" height="16" rx="3" fill="${active?'#263b4c':'#111c28'}"/>`+text(10,87+i*17,(active?'› ':'  ')+entry,active?'#7ed9bd':'#8b9eb3',9,500);});
  }else if(c.page==='settings'||c.page==='global'||c.page==='model'||c.page==='effort'){
    const global=c.page==='global',picker=c.page==='model'||c.page==='effort',options=global?c.globalMenu:picker?c.pickerLabels:[...MODES,'Back'];top=text(9,15,global?'GLOBAL SETTINGS':c.page==='model'?'SELECT MODEL':c.page==='effort'?'SELECT EFFORT':'PERMISSION MODE','#7ed9bd',10,650);
    const start=Math.max(0,Math.min(c.cursor-1,options.length-3));
    options.slice(start,start+3).forEach((option,i)=>{const y=29+i*23,active=start+i===c.cursor;body+=`<rect x="5" y="${y}" width="230" height="21" rx="4" fill="${active?'#263b4c':'#111c28'}"/>`+text(11,y+14,(active?'› ':'  ')+option,active?'#fff':'#90a3b8',11,active?600:400);});
    body+=text(9,108,global?'TURN: choose · PRESS: change · + close':'TURN: choose · PRESS: review · × back','#738ba2',8);footer='';
  }else{
    const q=c.confirm;
    if(q&&q.kind!=='permission'){
      top=text(9,15,q.kind==='model'?'CONFIRM MODEL CHANGE':'CONFIRM EFFORT CHANGE','#ffc76b',9,650);
      body+=text(9,39,clip(q.label,28),'#fff',14,650)+text(9,58,'Effort: '+effortLabel(q.effort),'#d6e2ee',12,600)+text(9,75,clip(q.row.label,32),'#aabdd0',10)+text(9,90,'Applies to subsequent turns','#ffc76b',9);
    }else{const mode=q?.mode||'';top=text(9,15,'CONFIRM PERMISSION CHANGE','#ffc76b',9,650);body+=text(9,41,mode,'#fff',16,650)+text(9,61,clip(q?.row.label||'',30),'#aabdd0',11)+text(9,83,mode.includes('Full')?'No sandbox or approval prompts':'Applies to subsequent turns','#ffc76b',10);}
    body+=text(9,104,'PRESS KNOB: apply   ·   × cancel','#8da3b9',9);footer='';
  }
  if(c.notice||c.busy)body+=`<rect x="4" y="97" width="232" height="15" rx="3" fill="#263b4c"/>`+text(9,108,clip(c.busy?'Sending…':c.notice,39),'#ffc76b',9);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="135"><rect width="240" height="135" fill="#101925"/><g font-family="Segoe UI,DejaVu Sans,sans-serif">${top}<path d="M8 20H232" stroke="#233244"/>${body}${footer}</g></svg>`;
}
export async function rgb565(svg:string,brightness=100):Promise<Buffer>{const raw=await sharp(Buffer.from(svg)).removeAlpha().toColourspace('srgb').raw().toBuffer(),out=Buffer.alloc(64800),factor=Math.max(0.1,Math.min(1,brightness/100));for(let i=0,j=0;i<raw.length;i+=3,j+=2)out.writeUInt16LE(((Math.round(raw[i]*factor)>>3)<<11)|((Math.round(raw[i+1]*factor)>>2)<<5)|(Math.round(raw[i+2]*factor)>>3),j);return out;}
