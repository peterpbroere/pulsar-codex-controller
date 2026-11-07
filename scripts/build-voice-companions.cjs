// Mechanical slicing/alignment only. Generate the source artwork with image_gen.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../assets/mascots/v1'),size=64;
async function build(name){
 const source=path.join(root,'sources',`${name}-voice-atlas.png`);
 const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const cells=[];
 for(let row=0;row<2;row++)for(let col=0;col<4;col++){
  const left=Math.round(col*info.width/4),right=Math.round((col+1)*info.width/4),top=Math.round(row*info.height/2),bottom=Math.round((row+1)*info.height/2);
  let x0=right,y0=bottom,x1=left,y1=top;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(data[(y*info.width+x)*4+3]>96){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  if(x1<=x0||y1<=y0)throw Error(`${name} has an empty voice animation cell`);
  cells.push({row,col,left:x0,top:y0,width:x1-x0+1,height:y1-y0+1});
 }
 const scale=56/Math.max(...cells.flatMap(c=>[c.width,c.height]));
 for(const c of cells){
  const state=c.row?'voice-speaking':'voice-listening',dir=path.join(root,name,state);fs.mkdirSync(dir,{recursive:true});
  const width=Math.max(1,Math.round(c.width*scale)),height=Math.max(1,Math.round(c.height*scale));
  const image=await sharp(data,{raw:info}).extract({left:c.left,top:c.top,width:c.width,height:c.height}).resize(width,height,{kernel:'nearest'}).png().toBuffer();
  await sharp({create:{width:size,height:size,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite([{input:image,left:Math.floor((size-width)/2),top:60-height}]).png().toFile(path.join(dir,`${c.col}.png`));
 }
}
(async()=>{
 for(const name of ['cat','owl'])await build(name);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 for(const name of ['cat','owl'])for(const state of ['voice-listening','voice-speaking'])manifest.mascots[name][state]={frames:4,delayMs:state==='voice-listening'?[420,320,160,420]:[160,180,140,180],frameDirectory:`${name}/${state}`,preview:`${name}-${state}.gif`};
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
