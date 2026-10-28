const {test}=require('node:test'),assert=require('node:assert/strict');
const {ButtonEdges,AUXILIARY_BUTTONS}=require('../dist/main/device/button-input');
test('recorded physical + and × sequence maps to settings then Back',()=>{
 const e=new ButtonEdges(AUXILIARY_BUTTONS);
 const frames=[[0x3ffff,0],[0x2ffff,100],[0x2ffff,1500],[0x3ffff,1700],[0x1ffff,8000],[0x3ffff,9500]];
 assert.deepEqual(frames.flatMap(([state,time])=>e.update(state,time)),['plus','minus']);
});
test('two separate + presses open and close settings once each',()=>{
 const {Controller}=require('../dist/main/controller');const c=new Controller(),e=new ButtonEdges(AUXILIARY_BUTTONS);
 for(const [state,time] of [[0x3ffff,0],[0x2ffff,100],[0x2ffff,200],[0x3ffff,400],[0x2ffff,1000],[0x3ffff,1200]]){
  for(const name of e.update(state,time))if(name==='plus')c.toggleGlobal();
 }
 assert.equal(c.page,'agent');
});
test('held active-low button yields one event until released',()=>{
 const e=new ButtonEdges(new Map([[16,'test-action']]));assert.deepEqual(e.update(0x3ffff,0),[]);
 assert.deepEqual(e.update(0x2ffff,10),['test-action']);assert.deepEqual(e.update(0x2ffff,300),[]);
 assert.deepEqual(e.update(0x3ffff,400),[]);assert.deepEqual(e.update(0x2ffff,500),['test-action']);
});
test('bounce is ignored and reset does not trigger an already held button',()=>{
 const e=new ButtonEdges(new Map([[16,'test-action']]));e.update(0x3ffff,0);e.update(0x2ffff,10);e.update(0x3ffff,20);
 assert.deepEqual(e.update(0x2ffff,25),[]);e.reset();assert.deepEqual(e.update(0x2ffff,500),[]);
});
test('unmapped main-key bits do not dispatch auxiliary actions',()=>{
 const e=new ButtonEdges(new Map([[16,'test-action']]));e.update(0x3ffff,0);assert.deepEqual(e.update(0x3fffe,20),[]);
});
