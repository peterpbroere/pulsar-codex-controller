const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ModernOpenCodeMonitor,readTabSessions}=require('../dist/main/opencode2');

function fixture(){
  const streams=new Set();
  const state={requests:[],authorized:true,online:true,events:[],sessions:[
    {id:'idle',title:'Open TUI',projectID:'p',location:{directory:'C:\\work\\idle'},model:{id:'gpt-x',providerID:'provider'},time:{created:1,updated:2,idle:2}},
    {id:'busy',title:'Working',projectID:'p',location:{directory:'C:\\work\\busy'},model:{id:'model-y',providerID:'provider',variant:'high'},time:{created:1,updated:3,busy:3,idle:2}},
    {id:'ghost',title:'Old history',projectID:'p',location:{directory:'C:\\work\\ghost'},time:{created:1,updated:4,idle:4}},
    {id:'child',parentID:'busy',title:'Child',location:{directory:'C:\\child'},time:{created:1,updated:5}},
    {id:'archived',title:'Archived',location:{directory:'C:\\archived'},time:{created:1,updated:6,archived:6}},
  ],permissions:{busy:[{id:'per_exact',sessionID:'busy',action:'bash',resources:['npm test'],metadata:{},source:{type:'tool',messageID:'msg',id:'call'}}]}};
  let sseResolve;const sseReady=new Promise(r=>sseResolve=r);
  const server=http.createServer((req,res)=>{
    state.requests.push({url:req.url,authorization:req.headers.authorization,method:req.method});
    if(req.headers.authorization!=='Bearer fixture')state.authorized=false;
    if(!state.online){res.writeHead(503);res.end();return;}
    if(req.url==='/api/event'){
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"id":"evt0","type":"server.connected","data":{}}\n\n');streams.add(res);sseResolve();
      const interval=setInterval(()=>res.write(': heartbeat\n\n'),1000);req.on('close',()=>{clearInterval(interval);streams.delete(res);});return;
    }
    let body='';req.on('data',x=>body+=x);req.on('end',()=>{
      if(req.url==='/api/info')return send(res,{version:'2.2.6',pid:22,urls:[],paths:{tmp:'tmp'}});
      if(req.url==='/api/session/active')return send(res,{data:{busy:{type:'running'}}});
      if(req.url.startsWith('/api/session?'))return send(res,{data:state.sessions,cursor:{}});
      const perm=req.url.match(/^\/api\/session\/([^/]+)\/permission$/);
      if(perm)return send(res,{data:state.permissions[decodeURIComponent(perm[1])]||[]});
      if(req.url.endsWith('/reply')){state.reply=JSON.parse(body);return noContent(res);}
      if(req.url.endsWith('/interrupt')){state.interrupted=true;return send(res,{interrupted:true});}
      if(req.url.endsWith('/prompt')){state.prompt=JSON.parse(body);return send(res,{data:{id:'in_1',sessionID:'idle',text:state.prompt.text}});}
      if(req.url==='/api/session/busy'){return send(res,{data:state.sessions.find(x=>x.id==='busy')});}
      res.writeHead(404);res.end();
    });
  });
  return {state,server,sseReady,emit:event=>{for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`);},listen:()=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port))),close:()=>new Promise(r=>server.close(r))};
}
function send(res,value){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function noContent(res){res.writeHead(204);res.end();}

test('v2 discovers only active, event seen, and open TUI sessions with session metadata',async()=>{
  const f=fixture(),port=await f.listen(),tabIds=['idle'];
  const connection={url:`http://127.0.0.1:${port}`,port,pid:22,version:'2.2.6',authorization:'Bearer fixture',executablePath:'opencode.exe',hasClient:true,tabFile:'tabs'};
  const monitor=new ModernOpenCodeMonitor(connection,()=>{},Date.now,()=>tabIds);
  try{
    await monitor.tick();
    const rows=monitor.rows();
    assert.deepEqual(rows.map(x=>x.id),[`oc:${port}:busy`,`oc:${port}:idle`]);
    assert.equal(rows.find(x=>x.session_id==='busy').state,'waiting');
    assert.equal(rows.find(x=>x.session_id==='busy').control_token,'per_exact');
    assert.equal(rows.find(x=>x.session_id==='busy').opencode.model,'provider/model-y');
    assert.equal(rows.find(x=>x.session_id==='idle').project,'C:\\work\\idle');
    assert.equal(f.state.authorized,true);
    connection.hasClient=false;
    await monitor.tick();
    assert.deepEqual(monitor.rows().map(x=>x.session_id),['busy'],'idle tabs are suppressed when their TUI client closes');
  }finally{monitor.close();await f.close();}
});

test('reads actual tab state including cwd keyed directory entries and ignores cwd without a client',()=>{
  const raw={global:{tabs:[{sessionID:'global-tab'}]},cwd:{'C:\\dev\\harnesk':{tabs:[{sessionID:'cwd-tab'}],unread:{}}}};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'opencode2-tabs-'));
  try{
    const file=path.join(directory,'tabs.json');fs.writeFileSync(file,JSON.stringify(raw));
    assert.deepEqual(readTabSessions(file),['global-tab','cwd-tab']);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('permission actions use exact request ID; stop and prompt use v2 routes',async()=>{
  const f=fixture(),port=await f.listen();
  const monitor=new ModernOpenCodeMonitor({url:`http://127.0.0.1:${port}`,port,pid:22,version:'2.2.6',authorization:'Bearer fixture',executablePath:'opencode.exe',hasClient:true,tabFile:'tabs'},()=>{},Date.now,()=>['idle']);
  try{
    await monitor.tick();
    await monitor.action(`oc:${port}:busy`,'approve','per_exact');
    assert.deepEqual(f.state.reply,{decision:'once'});
    await assert.rejects(()=>monitor.action(`oc:${port}:busy`,'approve','per_stale'),/stale|pending/i);
    await monitor.action(`oc:${port}:busy`,'stop',`ses:${port}:busy`);
    assert.equal(f.state.interrupted,true);
    await monitor.sendPrompt(`oc:${port}:idle`,'hello');
    assert.deepEqual(f.state.prompt,{text:'hello',metadata:{}});
    assert.ok(f.state.requests.some(r=>r.url===`/api/session/busy/permission/per_exact/reply`));
    assert.ok(f.state.requests.some(r=>r.url==='/api/session/busy/interrupt'));
    assert.ok(f.state.requests.some(r=>r.url==='/api/session/idle/prompt'));
  }finally{monitor.close();await f.close();}
});

test('SSE session events add live sessions; offline recovery and close clean up stream',async()=>{
  const f=fixture(),port=await f.listen();
  const monitor=new ModernOpenCodeMonitor({url:`http://127.0.0.1:${port}`,port,pid:22,version:'2.2.6',authorization:'Bearer fixture',executablePath:'opencode.exe'},()=>{},Date.now,()=>[]);
  try{
    await monitor.tick();await f.sseReady;
    // Event-seen sessions are admitted to the visible set, but populated by the next poll.
    f.state.sessions.push({id:'new',title:'Event session',location:{directory:'C:\\new'},time:{created:1,updated:8}});
    f.emit({id:'evt1',created:1,type:'session.created',location:{directory:'C:\\new'},data:{info:{id:'new'}}});
    await new Promise(r=>setTimeout(r,20));
    await monitor.tick();
    assert.ok(monitor.rows().some(r=>r.session_id==='new'));
    f.state.online=false;await monitor.tick();
    assert.equal(monitor.rows().find(r=>r.session_id==='busy').opencode.connected,false);
    f.state.online=true;await monitor.tick();
    assert.equal(monitor.rows().find(r=>r.session_id==='busy').opencode.connected,true);
  }finally{monitor.close();await f.close();}
});
