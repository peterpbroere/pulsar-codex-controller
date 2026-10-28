const fs=require('node:fs'),sharp=require('sharp');
const {Controller}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');
const row={id:'api',session_id:'api',label:'API service',state:'waiting',reason:'Approval needed',detail:'',project:'C:/dev/api',review:'Command:\nnpm run test:integration\nDirectory:\nC:/dev/api\nReason:\nVerify the API changes',control_token:'preview',actions:['approve','reject','focus','stop'],control_hint:'',settings:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},settings_token:'preview-settings'};
(async()=>{fs.mkdirSync('work',{recursive:true});const c=new Controller();c.update({connected:true,error:'',rows:[row]});c.markDisplayed('api','api','preview');const screens=[];
for(const [name,page] of [['approval','agent'],['details','details'],['global-settings','global'],['permission-mode','settings']]){c.page=page;c.cursor=page==='global'?1:0;const png=await sharp(Buffer.from(displaySvg(c))).png().toBuffer();fs.writeFileSync(`work/${name}.png`,png);screens.push({input:await sharp(png).resize(720,405,{kernel:'nearest'}).toBuffer(),left:0,top:(screens.length)*425});}
await sharp({create:{width:720,height:screens.length*425,channels:3,background:'#080e15'}}).composite(screens).png().toFile('work/screen-review.png');})();
