const {test}=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');
const comfy=(id,connected)=>({id,session_id:id,source:'comfyui',label:id,state:connected?'idle':'offline',reason:connected?'Idle':'Offline',detail:'',project:'',actions:['focus'],control_token:'-',review:'',control_hint:'',comfy:{connected,url:'http://localhost:8188',running:0,pending:0,promptId:'',node:'',helper:false}});
const agent={id:'agent',session_id:'agent',label:'Agent',state:'waiting',reason:'Approval',detail:'',project:'',actions:['approve'],control_token:'request',review:'Run tests',control_hint:''};
const snapshot=rows=>({rows,connected:true,error:''});
test('knob skips offline ComfyUI entries in both directions while desktop snapshot retains them',()=>{
 const c=new Controller();c.update(snapshot([agent,comfy('offline',false),comfy('online',true)]));
 assert.equal(c.snapshot.rows.length,3);assert.equal(c.rows.length,2);assert.match(displaySvg(c),/1 \/ 2/);
 c.rotate(1);assert.equal(c.selected,'online');c.rotate(1);assert.equal(c.selected,'agent');c.rotate(-1);assert.equal(c.selected,'online');
 c.select('offline');assert.equal(c.selected,'online');c.page='image';c.rotate(1);assert.equal(c.selected,'agent');assert.equal(c.page,'agent');
});
test('selected connection going offline leaves its image screen and requires the fallback agent approval to be displayed',()=>{
 const c=new Controller();c.update(snapshot([agent,comfy('gpu',true)]));c.select('gpu');c.page='image';
 c.update(snapshot([agent,comfy('gpu',false)]));assert.equal(c.selected,'agent');assert.equal(c.page,'agent');assert.equal(c.canApprove,false);assert.equal(c.key(0),undefined);
 c.markDisplayed('agent','agent','request');assert.equal(c.key(0).params.verb,'approve');
});
test('all offline connections leave an empty pad and reconnecting restores browsing without stealing an existing selection',()=>{
 const c=new Controller();c.update(snapshot([comfy('a',false),comfy('b',false)]));assert.equal(c.selected,'');assert.equal(c.row,undefined);assert.match(displaySvg(c),/0 \/ 0/);c.rotate(1);c.rotate(-1);assert.equal(c.selected,'');
 c.toggleGlobal();c.update(snapshot([comfy('a',false),comfy('b',false)]));assert.equal(c.page,'global');c.toggleGlobal();
 c.update(snapshot([comfy('a',false),comfy('b',true)]));assert.equal(c.selected,'b');assert.equal(c.rows.length,1);
 c.update(snapshot([comfy('a',true),comfy('b',true)]));assert.equal(c.selected,'b');c.rotate(1);assert.equal(c.selected,'a');
});
test('offline ComfyUI entries cannot be attention targets and do not hide idle Codex sessions',()=>{
 const c=new Controller(),offline={...comfy('offline',false),state:'error'};
 c.update(snapshot([{...agent,state:'idle'},offline,{...comfy('online',true),state:'error'}]));assert.equal(c.rows.length,2);assert.equal(c.attention.length,1);c.key(2);assert.equal(c.selected,'online');
});
