const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const sharp=require('sharp');
const {ComfyMonitor,connection}=require('../dist/main/comfyui');
const {Controller}=require('../dist/main/controller');
const {displaySvg,rgb565}=require('../dist/main/display');
const image=(filename='result.png',type='output')=>({filename,subfolder:'folder & more',type});
const item=(id,outputs={save:{images:[image()]}},status={status_str:'success',completed:true,messages:[]})=>({prompt:[1,id,{},{}],outputs,status});
async function server(t,initial={}){
 const png=await sharp({create:{width:24,height:40,channels:3,background:'#ff8844'}}).png().toBuffer();
 const state={queue:{queue_running:[],queue_pending:[]},history:{},helper:null,requests:[],...initial};
 const s=http.createServer((req,res)=>{state.requests.push({method:req.method,url:req.url});const path=new URL(req.url,'http://localhost');
  if(state.offline){res.writeHead(503).end();return;}
  const key=path.pathname.replace(/^\/prefix/,'');
  if(key==='/queue'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state.queue));}
  else if(key==='/history'){if(state.historyError)res.writeHead(500).end();else res.end(JSON.stringify(state.history));}
  else if(key==='/pulsar-deck/status'){if(state.helper)res.end(JSON.stringify(state.helper));else res.writeHead(404).end();}
  else if(key==='/view'){res.setHeader('Content-Type','image/png');res.end(state.badImage?Buffer.from('invalid image'):png);}
  else res.writeHead(404).end();
 });
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve);}));
 return {state,url:`http://127.0.0.1:${s.address().port}`};
}
test('connections validate names, normalize URLs and reject unsafe or ambiguous addresses',()=>{
 assert.equal(connection({id:'amd',name:'  AMD  ',url:'http://localhost:8188/'}).url,'http://localhost:8188');
 assert.equal(connection({name:'Remote',url:'https://example.com/comfy/'}).url,'https://example.com/comfy');
 for(const url of ['file:///C:/x','javascript:alert(1)','http://user:password@localhost:8188','http://localhost:8188?token=secret','http://localhost/#foo','localhost:8188'])assert.throws(()=>connection({name:'Test',url}));
 assert.throws(()=>connection({name:' ',url:'http://localhost'}));assert.throws(()=>connection({name:'x'.repeat(61),url:'http://localhost'}));
});
test('two instances independently monitor queue, matching progress and latest image with GET requests only',async t=>{
 const a=await server(t,{queue:{queue_running:[[1,'running',{},{}]],queue_pending:[[2,'next',{},{}]]},helper:{version:1,prompt_id:'running',node:'KSampler',value:18,max:30},history:{older:item('older')}});
 const b=await server(t,{history:{newest:item('newest',{save:{images:[image('owl.png')]}})}});
 const m=new ComfyMonitor();t.after(()=>m.close());m.configure([{id:'amd',name:'AMD',url:a.url},{id:'nvidia',name:'NVIDIA',url:b.url+'/prefix'}]);await m.tick();
 const [amd,nvidia]=m.rows();assert.equal(amd.state,'running');assert.equal(amd.comfy.pending,1);assert.deepEqual(amd.comfy.progress,{value:18,max:30});assert.equal(amd.comfy.latest.promptId,'older');
 assert.equal(nvidia.state,'idle');assert.equal(nvidia.comfy.latest.filename,'owl.png');assert.equal(nvidia.comfy.progress,undefined);assert.equal(amd.comfy.latest.filename,'result.png');
 assert.ok([...a.state.requests,...b.state.requests].every(r=>r.method==='GET'));assert.equal(a.state.requests.filter(r=>r.url.startsWith('/view')).length,1);
 await m.tick();assert.equal(a.state.requests.filter(r=>r.url.startsWith('/view')).length,1);
});
test('new completion updates image without replacing selection, and stale node progress is ignored',async t=>{
 let now=10000;const s=await server(t,{queue:{queue_running:[[1,'active',{},{}]],queue_pending:[]},helper:{version:1,prompt_id:'different-job',node:'Wrong stage',value:20,max:30}});
 const m=new ComfyMonitor(()=>{},()=>now);t.after(()=>m.close());m.configure([{id:'gpu',name:'GPU',url:s.url}]);await m.tick();assert.equal(m.rows()[0].comfy.progress,undefined);assert.equal(m.rows()[0].comfy.node,'');
 const c=new Controller();c.update({connected:false,error:'Codex offline',rows:m.rows()});const selected=c.selected;
 now+=2000;s.state.queue.queue_running=[];s.state.history={active:item('active')};await m.tick();c.update({connected:false,error:'',rows:m.rows()});
 assert.equal(c.selected,selected);assert.equal(c.row.reason,'Finished');assert.equal(c.row.comfy.latest.promptId,'active');assert.equal(c.row.comfy.progress,undefined);
});
test('saved image takes priority over temporary previews and the last image in its batch is shown',async t=>{
 const s=await server(t,{history:{done:item('done',{save:{images:[image('first.png'),image('last & ü.png')]},preview:{images:[image('preview.png','temp')]}})}});
 const m=new ComfyMonitor();t.after(()=>m.close());m.configure([{id:'a',name:'A',url:s.url}]);await m.tick();assert.equal(m.rows()[0].comfy.latest.filename,'last & ü.png');
 const query=new URL(s.state.requests.find(r=>r.url.startsWith('/view')).url,s.url).searchParams;assert.equal(query.get('filename'),'last & ü.png');assert.equal(query.get('subfolder'),'folder & more');
});
test('history completion order wins over queue number, cancelled or failed outputs are not presented as a success',async t=>{
 let now=10000;const s=await server(t,{history:{first:item('first'),front:item('front',{save:{images:[image('front.png')]}})}});s.state.history.front.prompt[0]=-10;
 const m=new ComfyMonitor(()=>{},()=>now);t.after(()=>m.close());m.configure([{id:'a',name:'A',url:s.url}]);await m.tick();assert.equal(m.rows()[0].comfy.latest.promptId,'front');
 now+=6000;s.state.history.failed=item('failed',{save:{images:[image('failed.png')]}},{status_str:'error',completed:false,messages:[]});await m.tick();assert.equal(m.rows()[0].state,'error');assert.equal(m.rows()[0].comfy.latest.promptId,'front');
 now+=6000;s.state.history.cancelled=item('cancelled',{save:{images:[image('partial.png')]}},{status_str:'error',completed:false,messages:[['execution_interrupted',{}]]});await m.tick();assert.equal(m.rows()[0].reason,'Cancelled');assert.equal(m.rows()[0].state,'idle');assert.equal(m.rows()[0].comfy.latest.promptId,'front');
});
test('offline server retains its entry and last image, and recovers without affecting another instance',async t=>{
 let now=10000;const a=await server(t,{history:{done:item('done')}}),b=await server(t);
 const m=new ComfyMonitor(()=>{},()=>now);t.after(()=>m.close());m.configure([{id:'a',name:'A',url:a.url},{id:'b',name:'B',url:b.url}]);await m.tick();const original=m.rows()[0].comfy.latest;
 now+=2000;a.state.offline=true;await m.tick();assert.equal(m.rows()[0].state,'offline');assert.deepEqual(m.rows()[0].comfy.latest,original);assert.equal(m.rows()[1].comfy.connected,true);
 now+=6000;a.state.offline=false;await m.tick();assert.equal(m.rows()[0].comfy.connected,true);assert.deepEqual(m.rows()[0].comfy.latest,original);
});
test('invalid images do not break monitoring or replace the last valid image and retries are bounded',async t=>{
 let now=10000;const s=await server(t,{history:{first:item('first')}});const m=new ComfyMonitor(()=>{},()=>now);t.after(()=>m.close());m.configure([{id:'a',name:'A',url:s.url}]);await m.tick();
 const original=m.rows()[0].comfy.latest;now+=6000;s.state.history.next=item('next',{save:{images:[image('bad.png')]}});s.state.badImage=true;await m.tick();
 assert.deepEqual(m.rows()[0].comfy.latest,original);assert.equal(m.rows()[0].comfy.connected,true);assert.match(m.rows()[0].comfy.imageError,/unavailable/);
 const count=s.state.requests.filter(r=>r.url.startsWith('/view')).length;now+=2000;await m.tick();assert.equal(s.state.requests.filter(r=>r.url.startsWith('/view')).length,count);
 now+=31000;s.state.badImage=false;await m.tick();assert.equal(m.rows()[0].comfy.latest.filename,'bad.png');assert.equal(m.rows()[0].comfy.imageError,'');
});
test('history failure preserves queue connection and clears its warning when history recovers',async t=>{
 let now=10000;const s=await server(t,{historyError:true});const m=new ComfyMonitor(()=>{},()=>now);t.after(()=>m.close());m.configure([{id:'a',name:'A',url:s.url}]);await m.tick();assert.equal(m.rows()[0].comfy.connected,true);assert.match(m.rows()[0].comfy.imageError,/History/);
 now+=6000;s.state.historyError=false;await m.tick();assert.equal(m.rows()[0].comfy.imageError,'');
});
test('editing a server URL clears the old server image while a name edit preserves its identity',async t=>{
 const a=await server(t,{history:{done:item('done')}}),b=await server(t);
 const m=new ComfyMonitor();t.after(()=>m.close());m.configure([{id:'a',name:'A',url:a.url}]);await m.tick();assert.ok(m.rows()[0].comfy.latest);
 m.configure([{id:'a',name:'Renamed',url:a.url}]);assert.ok(m.rows()[0].comfy.latest);assert.equal(m.rows()[0].label,'Renamed');
 m.configure([{id:'a',name:'Renamed',url:b.url}]);assert.equal(m.rows()[0].comfy.latest,undefined);assert.equal(m.rows()[0].id,'comfy:a');await m.tick();assert.equal(m.rows()[0].comfy.connected,true);
});
test('ComfyUI controls never route to Codex, image viewing preserves key meanings, and removed entries disappear',async t=>{
 const s=await server(t,{history:{done:item('done')}});const m=new ComfyMonitor();t.after(()=>m.close());m.configure([{id:'a',name:'A',url:s.url}]);await m.tick();
 const c=new Controller();c.update({connected:false,error:'',rows:m.rows()});assert.equal(c.canChooseModel,false);assert.equal(c.key(0),undefined);assert.equal(c.action('stop'),undefined);assert.deepEqual(c.key(1),{method:'comfy-focus',params:{id:'comfy:a'}});
 c.press();assert.equal(c.menu[0],'Latest image');c.press();assert.equal(c.page,'image');assert.equal(c.key(0),undefined);assert.match(displaySvg(c),/LATEST IMAGE/);assert.equal((await rgb565(displaySvg(c))).length,64800);c.cancelOrBack();assert.equal(c.page,'agent');
 assert.match(displaySvg(c),/COMFYUI/);assert.doesNotMatch(displaySvg(c),/Model unknown|Unknown/);m.configure([]);c.update({connected:false,error:'',rows:m.rows()});assert.equal(c.row,undefined);
});
