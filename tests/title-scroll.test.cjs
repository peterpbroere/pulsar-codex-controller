const {test}=require('node:test'),assert=require('node:assert/strict');
const {TitleScroller,measureTitleWidth}=require('../dist/main/title-scroll');
const {Controller}=require('../dist/main/controller');
const {displaySvg,rgb565}=require('../dist/main/display');
const sharp=require('sharp');
const row=(label='A title longer than the screen can show at once')=>({id:'a',session_id:'session-a',label,state:'idle',reason:'Turn stopped',detail:'',project:'C:\\dev\\project',actions:[],control_token:'one',review:'',control_hint:''});
const setup=r=>{const c=new Controller();c.update({rows:[r],connected:true,error:''});return c;};

test('long titles pause at each end and return at a steady speed',async()=>{
 const p=new TitleScroller(async()=>294);await p.prepare('Long title');
 assert.deepEqual(p.frame('a','Long title',0),{offset:0,scrolling:true});assert.equal(p.frame('a','Long title',1700).offset,0);
 assert.equal(p.frame('a','Long title',2800).offset,24);assert.equal(p.frame('a','Long title',5000).offset,74);
 assert.equal(p.frame('a','Long title',6400).offset,74);assert.equal(p.frame('a','Long title',7500).offset,50);assert.equal(p.frame('a','Long title',10000).offset,0);
});
test('selection, rename and returning from menus restart scrolling; ordinary refreshes do not',async()=>{
 const p=new TitleScroller(async()=>400);await p.prepare('Title');await p.prepare('Renamed');
 p.frame('a','Title',0);assert.equal(p.frame('a','Title',3000).offset,29);assert.equal(p.frame('a','Title',3100).offset,31);
 assert.equal(p.frame('b','Title',3200).offset,0);assert.equal(p.frame('b','Renamed',6000).offset,0);
 p.frame('b','Renamed',9000);p.reset();assert.equal(p.frame('b','Renamed',10000).offset,0);
});
test('short titles remain still, measured widths are reused, and failed measurements do not break rendering',async()=>{
 let calls=0;const p=new TitleScroller(async()=>{calls++;return 100;});
 await Promise.all([p.prepare('Short'),p.prepare('Short')]);assert.equal(calls,1);assert.deepEqual(p.frame('a','Short',0),{offset:0,scrolling:false});assert.deepEqual(p.frame('a','Short',100000),{offset:0,scrolling:false});await p.prepare('Short');assert.equal(calls,1);
 const broken=new TitleScroller(async()=>{throw Error('Font unavailable');});await broken.prepare('Title');assert.equal(broken.frame('a','Title',0).offset,0);
});
test('real font measurement accounts for wide glyphs and treats markup as literal text',async()=>{
 const thin=await measureTitleWidth('iiiiiiiiiiiiiiiiiiiiiiiiiiiiii');const wide=await measureTitleWidth('WWWWWWWWWWWWWWWWWWWW');assert.ok(thin<222);assert.ok(wide>222);
 assert.ok(await measureTitleWidth('<b>Title & name</b>')>await measureTitleWidth('Title & name'));
});
test('scrolling changes only the clipped title region and never approves or changes an agent',async()=>{
 const r=row('Wide title & <literal text> that needs horizontal scrolling'),c=setup({...r,state:'waiting',actions:['approve'],review:'Command:\nnpm test'});
 const still=displaySvg(c,undefined,{offset:0,scrolling:true}),moving=displaySvg(c,undefined,{offset:45,scrolling:true});assert.match(still,/&amp; &lt;literal text&gt;/);assert.match(moving,/x="-45"/);assert.equal(c.displayedApproval,null);assert.equal(c.key(0),undefined);c.notice='';
 const a=await sharp(Buffer.from(still)).raw().toBuffer(),b=await sharp(Buffer.from(moving)).raw().toBuffer();const channels=a.length/(240*135);
 assert.deepEqual(a.subarray(44*240*channels),b.subarray(44*240*channels));assert.notDeepEqual(a,b);assert.equal(c.row.label,r.label);assert.equal((await rgb565(still)).length,64800);
});
test('working directory follows short status text while long approval previews keep three lines and an ellipsis',()=>{
 const idle=displaySvg(setup(row()));assert.match(idle,/y="73" width="222"/);assert.match(idle,/DIR: C:\\dev\\project/);
 const c=setup({...row(),state:'waiting',review:'Command:\n'+('Review this command carefully '.repeat(25)),actions:['approve']});const original=c.row.review,svg=displaySvg(c);
 assert.match(svg,/y="99" width="222"/);assert.match(svg,/height="42"/);assert.match(svg,/Preview truncated/);assert.match(svg,/…/);assert.equal(c.row.review,original);
 const longPath=row();longPath.project='C:\\very-long-parent-directory\\nested-project\\specific-folder';assert.match(displaySvg(setup(longPath)),/DIR: …/);
});
