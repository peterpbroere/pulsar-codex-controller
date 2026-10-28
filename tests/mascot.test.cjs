const {test}=require('node:test'),assert=require('node:assert/strict');
const {MascotPlayer}=require('../dist/main/mascot');
const {Controller}=require('../dist/main/controller');
const {displaySvg,rgb565}=require('../dist/main/display');
const row=(state='idle',id='a',reason='Ready')=>({id,session_id:id,label:'API service',state,reason,detail:'',project:'C:/dev/example',actions:[],control_token:'one',review:'',control_hint:''});
const snapshot=(rows,connected=true)=>({rows,connected,error:''});
const player=()=>new MascotPlayer(Object.fromEntries(['cat','owl'].map(name=>[name,Object.fromEntries(['idle','working','approval','done','error'].map(state=>[state,{images:[`${name}-${state}-0`,`${name}-${state}-1`,`${name}-${state}-2`],delayMs:[100,200,300]}]))])));
const assets=MascotPlayer.load(require('node:path').resolve(__dirname,'..'));
test('existing preferences get a cat by default; invalid saved values cannot choose asset paths',()=>{
 const c=new Controller();c.loadPreferences({brightness:70,lights:false});assert.deepEqual(c.preferences,{brightness:70,lights:false,mascot:'cat'});
 c.loadPreferences({mascot:'owl',brightness:Infinity,lights:'yes'});assert.deepEqual(c.preferences,{brightness:70,lights:false,mascot:'owl'});
 c.loadPreferences({mascot:'../../outside'});assert.equal(c.preferences.mascot,'owl');assert.throws(()=>c.setMascot('../../outside'));
 c.loadPreferences(null);assert.equal(c.preferences.mascot,'owl');
});
test('knob cycles Cat, Owl, Off and Cat without closing global settings',()=>{
 const c=new Controller();c.toggleGlobal();c.cursor=2;
 for(const next of ['owl','off','cat']){c.press();assert.equal(c.preferences.mascot,next);assert.equal(c.page,'global');}
 c.rotate(1);c.press();assert.equal(c.page,'agent');
});
test('states map to the matching poses, with a sleeping mascot when disconnected',()=>{
 const p=player();for(const [agent,state] of [['waiting','approval'],['running','working'],['error','error'],['idle','idle']])assert.equal(p.frame('cat',row(agent),true,1000).state,state);
 assert.equal(p.frame('owl',row('waiting'),false,1000).state,'idle');assert.equal(p.frame('cat',undefined,true,1000).state,'idle');assert.equal(p.frame('off',row('running'),true,1000),null);
});
test('finish animation is temporary and belongs to the agent whose observed turn ended',()=>{
 const p=player();p.observe(snapshot([row('idle')]),0);assert.equal(p.frame('cat',row(),true,0).state,'idle');
 p.observe(snapshot([row('running')]),1000);p.observe(snapshot([row('idle')]),2000);
 assert.equal(p.frame('cat',row(),true,2001).state,'done');p.observe(snapshot([row('idle')]),4000);
 assert.equal(p.frame('cat',row('idle','b'),true,4000).state,'idle');assert.equal(p.frame('cat',row(),true,7000).state,'idle');
 p.observe(snapshot([row('running')]),8000);p.observe(snapshot([row('idle','a','Interrupted')]),9000);assert.equal(p.frame('cat',row(),true,9000).state,'idle');
 p.observe(snapshot([row('running')]),10000);p.observe(snapshot([row()]),11000);p.observe(snapshot([],false),11001);assert.equal(p.frame('cat',row(),true,11002).state,'idle');
});
test('frame durations loop correctly and selection or state changes start at frame zero',()=>{
 const p=player(),a=row('running');assert.equal(p.frame('cat',a,true,1000).index,0);assert.equal(p.frame('cat',a,true,1099).index,0);
 assert.equal(p.frame('cat',a,true,1100).index,1);assert.equal(p.frame('cat',a,true,1300).index,2);assert.equal(p.frame('cat',a,true,1600).index,0);
 assert.equal(p.frame('owl',a,true,1650).index,0);assert.equal(p.frame('owl',row('running','b'),true,1800).index,0);assert.equal(p.frame('owl',row('waiting','b'),true,1900).state,'approval');
});
test('both bundled mascots load every state with real PNG frames at LCD size',async()=>{
 const sharp=require('sharp'),p=await assets;
 for(const name of ['cat','owl'])for(const state of ['idle','running','waiting','error']){
  const image=p.frame(name,row(state),true,1000).image;assert.match(image,/^data:image\/png;base64,/);
  const m=await sharp(Buffer.from(image.split(',')[1],'base64')).metadata();assert.equal(m.width,48);assert.equal(m.height,48);assert.equal(m.hasAlpha,true);
 }
});
test('mascot pixels render on LCD, stay out of menus, and do not authorize newer requests',async()=>{
 const p=await assets,c=new Controller();c.update(snapshot([{...row('waiting'),review:'Command:\nnpm test\n'+'More details '.repeat(30),actions:['approve']}])) ;
 c.markDisplayed('a','a','one');const image=p.frame('cat',c.row,true,1000).image,svg=displaySvg(c,image);
 assert.match(svg,/<image x="184"/);assert.match(svg,/width="166"/);assert.match(svg,/Preview truncated/);assert.equal(c.canApprove,true);
 const actual=await rgb565(svg),plain=await rgb565(displaySvg(c));assert.equal(actual.length,64800);
 const offset=(80*240+205)*2;assert.notDeepEqual(actual.subarray(offset,offset+30),plain.subarray(offset,offset+30));
 c.update(snapshot([{...c.row,control_token:'new'}]));displaySvg(c,image);assert.equal(c.canApprove,false);assert.equal(c.key(0),undefined);
 c.toggleGlobal();assert.doesNotMatch(displaySvg(c,image),/<image /);assert.doesNotMatch(displaySvg(new Controller()),/<image /);
});
