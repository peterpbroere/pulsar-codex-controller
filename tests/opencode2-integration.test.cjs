const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OpenCodeMonitor}=require('../dist/main/opencode');

test('parent discovers authenticated 2.x after legacy HTML and routes the exact approval',async t=>{
 const calls=[],authorization='Basic synthetic-test-authorization';let resolved=false;
 t.mock.method(global,'fetch',async(url,init={})=>{
  const path=new URL(url).pathname;calls.push({path,init});
  if(path==='/global/health')return new Response('<!doctype html><html></html>');
  assert.equal(init.headers.authorization,authorization);
  if(path==='/api/event')return new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.close(),{once:true});}}));
  if(path==='/api/info')return Response.json({version:'2.2.6',pid:100});
  if(path==='/api/session/active')return Response.json({data:{ses_live:{type:'running'}}});
  if(path==='/api/session')return Response.json({data:[{id:'ses_live',title:'Live agent',location:{directory:'C:/dev/example'}}],cursor:{}});
  if(path==='/api/session/ses_live/permission')return Response.json({data:resolved?[]:[{id:'per_exact',sessionID:'ses_live',action:'edit',resources:['src/example.ts']}]});
  if(path==='/api/session/ses_live/permission/per_exact/reply'){
   assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(init.body),{decision:'once'});resolved=true;return new Response(null,{status:204});
  }
  throw Error('Unexpected route '+path);
 });
 let clock=0;
 const monitor=new OpenCodeMonitor(()=>{},()=>clock,async()=>[{address:'127.0.0.1',port:4096,pid:100,executablePath:'C:/tools/opencode.exe',hasClient:true}],async(listener,executablePath,hasClient)=>({url:'http://127.0.0.1:4096',port:listener.port,pid:listener.pid,version:'2.2.6',authorization,executablePath,hasClient}));
 try{
  await monitor.tick();const row=monitor.rows()[0];
  assert.equal(row.label,'Live agent');assert.equal(row.state,'waiting');assert.equal(row.control_token,'per_exact');
  await assert.rejects(()=>monitor.action(row.id,'approve','per_stale'),/stale|pending/i);
  await monitor.action(row.id,'approve','per_exact');
  assert.equal(resolved,true);assert.equal(monitor.rows()[0].state,'running');
  assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
 }finally{monitor.close();}
});
