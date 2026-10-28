// Mechanical atlas slicing, alignment and GIF encoding. Art is generated separately.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../assets/mascots/v1');
const states=['idle','working','approval','done','error'];
const specs={cat:{rows:[0,237,472,714,933,1145],omit:{working:[4]}},owl:{rows:[0,248,478,733,937,1145],omit:{}}};
const size=64,zoom=3;
const delays={idle:[440,360,340,440,360,500],working:[150,150,180,150,180,150],approval:[400,250,300,300,200,450],done:[240,180,180,240,260,350],error:[450,300,350,450,300,450]};
async function gif(frames,file,delay){
 const meta=await sharp(frames[0]).metadata(),raws=[];
 for(const frame of frames)raws.push(await sharp(frame).ensureAlpha().raw().toBuffer());
 await sharp(Buffer.concat(raws),{raw:{width:meta.width,height:meta.height*frames.length,channels:4,pageHeight:meta.height}})
  .gif({loop:0,delay,colours:256,dither:0,effort:7}).toFile(file);
}
async function run(){
 fs.mkdirSync(root,{recursive:true});const animations={},manifest={version:1,nativeFrameSize:[size,size],previewScale:zoom,mascots:{}};
 for(const [name,spec] of Object.entries(specs)){
  const {data,info}=await sharp(path.join(root,'sources',`${name}-atlas.png`)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  animations[name]={};manifest.mascots[name]={};
  for(let row=0;row<5;row++){
   const state=states[row],top=spec.rows[row],bottom=spec.rows[row+1],cuts=[0];
   for(let col=1;col<6;col++){
    const expected=Math.round(info.width*col/6);let best=expected,cost=Infinity;
    for(let x=expected-10;x<=expected+10;x++){
     let n=0;for(let y=top;y<bottom;y++)if(data[(y*info.width+x)*4+3]>80)n++;
     const c=n+Math.abs(x-expected)/100;if(c<cost){cost=c;best=x;}
    }cuts.push(best);
   }cuts.push(info.width);
   const cells=[];
   for(let col=0;col<6;col++){
    if(spec.omit[state]?.includes(col))continue;
    const left=cuts[col],right=cuts[col+1];let x0=right,x1=left,y0=bottom,y1=top;
    for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(data[(y*info.width+x)*4+3]>80){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
    let anchor=(x0+x1)/2;
    if(['working','approval','error'].includes(state)){
     let lo=right,hi=left;
     for(let y=Math.max(y0,y1-26);y<=y1;y++)for(let x=x0;x<=x1;x++){
      const i=(y*info.width+x)*4,[r,g,b,a]=data.subarray(i,i+4);
      if(a>100&&b>r+4&&b>g+2&&r<125&&b<150){lo=Math.min(lo,x);hi=Math.max(hi,x);}
     }if(hi>=lo)anchor=(lo+hi)/2;
    }
    cells.push({col,x0,x1,y0,y1,anchor});
   }
   const minLeft=Math.min(...cells.map(c=>c.x0-c.anchor)),maxRight=Math.max(...cells.map(c=>c.x1-c.anchor));
   const scale=Math.min(56/(maxRight-minLeft+1),56/Math.max(...cells.map(c=>c.y1-c.y0+1)));
   const anchor=4-minLeft*scale,frames=[],large=[];
   const dir=path.join(root,name,state);fs.mkdirSync(dir,{recursive:true});
   for(let n=0;n<cells.length;n++){
    const c=cells[n],width=c.x1-c.x0+1,height=c.y1-c.y0+1;
    const sprite=await sharp(data,{raw:info}).extract({left:c.x0,top:c.y0,width,height}).resize(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)),{kernel:'nearest'}).png().toBuffer();
    const m=await sharp(sprite).metadata(),left=Math.max(0,Math.min(size-m.width,Math.round(anchor+(c.x0-c.anchor)*scale)));
    const bob=name==='owl'&&state==='done'?[0,1,3,2,0,0][n]:0;
    const frame=await sharp({create:{width:size,height:size,channels:4,background:'#00000000'}}).composite([{input:sprite,left,top:size-4-m.height-bob}]).png().toBuffer();
    frames.push(frame);fs.writeFileSync(path.join(dir,`${n}.png`),frame);
    large.push(await sharp(frame).resize(size*zoom,size*zoom,{kernel:'nearest'}).png().toBuffer());
   }
   const timing=cells.map(c=>delays[state][c.col]);animations[name][state]=large;
   await gif(large,path.join(root,`${name}-${state}.gif`),timing);
   manifest.mascots[name][state]={frames:cells.length,delayMs:timing,frameDirectory:`${name}/${state}`,preview:`${name}-${state}.gif`};
  }
 }
 const previewFrames=[],review=[];
 // 90 frames closes both the five-frame typing cycle and all six-frame cycles.
 for(let t=0;t<90;t++){
  const composites=[];
  for(const [r,name] of ['cat','owl'].entries())for(const [col,state] of states.entries()){
   const frames=animations[name][state],pace=state==='working'?1:state==='done'?2:3;
   composites.push({input:frames[Math.floor(t/pace)%frames.length],left:col*208+8,top:r*224+48});
  }
  const labels=`<svg width="1040" height="496"><style>text{font-family:Segoe UI,sans-serif;fill:#bacbd8;font-size:15px;letter-spacing:1px}</style>${states.map((s,i)=>`<text x="${i*208+104}" y="25" text-anchor="middle">${s.toUpperCase()}</text>`).join('')}<text x="12" y="53" font-size="11">CAT</text><text x="12" y="277" font-size="11">OWL</text></svg>`;
  composites.push({input:Buffer.from(labels),left:0,top:0});
  const frame=await sharp({create:{width:1040,height:496,channels:4,background:'#101925'}}).composite(composites).png().toBuffer();
  previewFrames.push(frame);if([0,6,12].includes(t))review.push(frame);
 }
 await gif(previewFrames,path.join(root,'preview.gif'),180);
 fs.writeFileSync(path.join(root,'preview-still.png'),previewFrames[0]);
 await sharp({create:{width:1040,height:496*review.length,channels:4,background:'#101925'}}).composite(review.map((input,i)=>({input,left:0,top:i*496}))).png().toFile(path.join(root,'review-frames.png'));
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const links=states.map(s=>`<section><h2>${s}</h2><div><figure><img src="cat-${s}.gif"><figcaption>Cat</figcaption></figure><figure><img src="owl-${s}.gif"><figcaption>Owl</figcaption></figure></div></section>`).join('');
 fs.writeFileSync(path.join(root,'preview.html'),`<!doctype html><meta charset="utf-8"><title>Desk companions — animation concepts</title><style>body{font-family:Segoe UI,sans-serif;background:#101925;color:#dce8ef;margin:36px auto;max-width:1060px}h1{font-size:24px}main{display:flex;gap:12px;flex-wrap:wrap}section{background:#182535;border-radius:12px;padding:12px}h2{text-transform:capitalize;font-size:15px;text-align:center}section div{display:flex}figure{margin:0}img{width:192px;height:192px;image-rendering:pixelated}figcaption{text-align:center;color:#9bb3c4;font-size:13px}p{color:#9bb3c4}</style><h1>Desk companions</h1><p>First animation concepts · original tuxedo cat and little owl</p><main>${links}</main>`);
 console.log(JSON.stringify({output:root,animations:10,nativeFrameSize:size,manifest},null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
