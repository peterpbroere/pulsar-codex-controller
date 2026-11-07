const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {OpenCodeMonitor,parseListeners,attachArgs,openCodeModelLabel,pendingPreview,normalizePending}=require('../dist/main/opencode');
const {Controller,modelLabel}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');

function stubServer(initial={}) {
  const state={sessions:initial.sessions??[],statuses:initial.statuses??{},pending:initial.pending??[],posts:[]};
  const clients=new Set();
  let sseReady,eventId=0;
  const sseConnected=new Promise(resolve=>{sseReady=resolve;});
  // Real wire envelope verified on opencode 1.19.2: {directory, project, payload:{id, type, properties}}.
  const emit=(type,properties={})=>{const frame={directory:'global',project:'global',payload:{id:'evt_'+(++eventId),type,properties}};for(const res of clients)res.write(`data: ${JSON.stringify(frame)}\n\n`);};
  const server=http.createServer((req,res)=>{
    let body='';
    req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{
      const path=req.url.split('?')[0];
      const parsed=body?JSON.parse(body):{};
      if(req.method==='POST')state.posts.push({path,body:parsed});
      if(path==='/global/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({healthy:true,version:'1.19.2-test'}));}
      else if(path==='/session'){res.writeHead(200);res.end(JSON.stringify(state.sessions));}
      else if(path==='/session/status'){res.writeHead(200);res.end(JSON.stringify(state.statuses));}
      else if(path==='/permission'){res.writeHead(200);res.end(JSON.stringify(state.pending.filter(p=>!p.action&&!p.resources)));}
      else if(/^\/session\/[^/]+$/.test(path)&&req.method==='PATCH'){
        const id=decodeURIComponent(path.split('/')[2]);
        const session=state.sessions.find(s=>s.id===id);
        if(!session){res.writeHead(404);res.end('{}');}
        else{
          if(parsed.permission!==undefined)session.permission=parsed.permission;
          if(parsed.title!==undefined)session.title=parsed.title;
          res.writeHead(200);res.end(JSON.stringify(session));
        }
      }
      else if(path==='/api/session/s1/permission'){res.writeHead(200);res.end(JSON.stringify({data:state.pending.filter(p=>p.sessionID==='s1'&&(p.action||p.resources))}));}
      else if(path==='/global/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({directory:'global',project:'global',payload:{id:'evt_0',type:'server.connected',properties:{}}})}\n\n`);clients.add(res);sseReady();res.on('close',()=>clients.delete(res));}
      else if(/^\/permission\/[^/]+\/reply$/.test(path)&&req.method==='POST'){
        const id=decodeURIComponent(path.split('/')[2]);
        state.pending=state.pending.filter(p=>p.id!==id);
        emit('permission.replied',{id});
        res.writeHead(200);res.end('true');
      }
      else if(/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path)&&req.method==='POST'){
        const id=decodeURIComponent(path.split('/')[5]);
        state.pending=state.pending.filter(p=>p.id!==id);
        emit('permission.v2.replied',{id});
        res.writeHead(200);res.end('true');
      }
      else if(/^\/session\/[^/]+\/abort$/.test(path)&&req.method==='POST'){
        const id=decodeURIComponent(path.split('/')[2]);
        state.statuses[id]={type:'idle'};
        res.writeHead(200);res.end('true');
      }
      else if(/^\/session\/[^/]+\/prompt_async$/.test(path)&&req.method==='POST'){
        const id=decodeURIComponent(path.split('/')[2]);
        state.statuses[id]={type:'busy'};
        res.writeHead(204);res.end();
      }
      else{res.writeHead(404);res.end('{}');}
    });
  });
  return {state,emit,sseConnected,listen:()=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port))),close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)})};
}
const session=(id,extra={})=>({id,title:extra.title??`Session ${id}`,directory:extra.directory??`C:\\dev\\${id}`,time:{created:1,updated:extra.updated??Date.now()},...(extra.raw??{})});

test('netstat listeners are parsed for opencode pids only',()=>{
  const output=['','  TCP    127.0.0.1:4096       0.0.0.0:0    LISTENING   111','  TCP    0.0.0.0:8188         0.0.0.0:0    LISTENING   222','  TCP    [::1]:4097           [::]:0       LISTENING   111','  TCP    127.0.0.1:1900       0.0.0.0:0    LISTENING   333','  UDP    127.0.0.1:5353       *:*                          111'].join('\r\n');
  const listeners=parseListeners(output,new Set([111,222]));
  assert.deepEqual(listeners.map(l=>[l.address,l.port,l.pid]),[['127.0.0.1',4096,111],['127.0.0.1',8188,222],['[::1]',4097,111]]);
});

test('attach command targets the server URL and continues the shown session',()=>{
  assert.deepEqual(attachArgs('http://127.0.0.1:4096','ses_ab12'),
    {file:'cmd.exe',args:['/c','start','Pulsar OpenCode','cmd','/k','opencode','attach','http://127.0.0.1:4096','--session','ses_ab12']});
});

test('model label, pending previews, and normalization are defensive',()=>{
  assert.equal(openCodeModelLabel({connected:true,url:'x',port:1,version:'1',model:'anthropic/claude-sonnet-4-5'}),'claude-sonnet-4-5');
  assert.equal(openCodeModelLabel({connected:true,url:'x',port:1,version:'1',model:'openai/gpt-5',modelVariant:'thinking'}),'gpt-5 · thinking');
  assert.equal(openCodeModelLabel(undefined),'OPENCODE');
  assert.deepEqual(normalizePending({id:'per_1',sessionID:'s1',permission:'bash',patterns:['npm test'],metadata:{title:'Run tests'}}),
    {id:'per_1',sessionID:'s1',permission:'bash',patterns:['npm test'],resources:[],metadata:{title:'Run tests'},v2:false});
  const v2=normalizePending({id:'per_2',sessionID:'s2',action:'edit',resources:['src/x.ts']});
  assert.deepEqual(v2,{id:'per_2',sessionID:'s2',permission:'edit',patterns:[],resources:['src/x.ts'],metadata:{},v2:true});
  assert.equal(normalizePending({id:'per_3'}),undefined);
  assert.equal(pendingPreview({id:'per_1',sessionID:'s1',permission:'bash',patterns:['npm test'],resources:[],metadata:{title:'Run tests'},v2:false}),'bash request\nnpm test\nRun tests');
  assert.equal(pendingPreview({id:'per_2',sessionID:'s2',permission:'edit',patterns:[],resources:['src/x.ts'],metadata:{},v2:true}),'edit request\nsrc/x.ts');
});

test('discovers servers and maps sessions to rows',async()=>{
  const now=Date.now();
  const stub=stubServer({sessions:[session('s1',{title:'Fix login bug',updated:now}),session('s2',{title:'',updated:now-3600000,directory:'C:\\dev\\tools'}),{id:'child',parentID:'s1',title:'subagent',time:{created:1,updated:now}},{id:'old',title:'archived',time:{created:1,updated:now,archived:3}}],
    statuses:{s1:{type:'busy'},s2:{type:'retry',attempt:2,message:'Provider overloaded'}}});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    assert.equal(monitor.rows().length,0,'database history appeared without any activity');
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    stub.emit('message.updated',{info:{sessionID:'s2'}});
    await new Promise(r=>setTimeout(r,60));
    const rows=monitor.rows();
    assert.equal(rows.length,2);
    const first=rows.find(r=>r.session_id==='s1');
    assert.equal(first.label,'Fix login bug');
    assert.equal(first.state,'running');
    assert.deepEqual(first.actions,['stop','focus']);
    assert.equal(first.opencode.model,undefined);
    assert.equal(first.opencode.connected,true);
    const second=rows.find(r=>r.session_id==='s2');
    assert.equal(second.state,'error');
    assert.equal(second.reason,'Retrying');
    assert.equal(second.detail,'Provider overloaded');
    assert.deepEqual(second.actions,['continue','focus']);
    assert.equal(second.project,'C:\\dev\\tools');
    assert.equal(second.label,'tools');
  }finally{monitor.close();await stub.close();}
});

test('permission requests wait, approve once, and reject stale tokens',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'busy'}}});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('permission.asked',{id:'per_1',sessionID:'s1',permission:'bash',patterns:['npm test'],metadata:{title:'Run tests'}});
    await new Promise(r=>setTimeout(r,60));
    let row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'waiting');
    assert.deepEqual(row.actions,['approve','reject','focus']);
    assert.equal(row.control_token,'per_1');
    assert.equal(row.review,'bash request\nnpm test\nRun tests');
    await monitor.action(row.id,'approve','per_1');
    assert.deepEqual(stub.state.posts.find(p=>p.path==='/permission/per_1/reply'),{path:'/permission/per_1/reply',body:{reply:'once'}});
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'running');
    await assert.rejects(()=>monitor.action(row.id,'approve','per_1'),/No pending request/);
  }finally{monitor.close();await stub.close();}
});

test('v2 permissions reply on the session endpoint and survive repeated polls',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'busy'}}});
  const port=await stub.listen();
  let clock=Date.now();
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('permission.v2.asked',{id:'per_v2',sessionID:'s1',action:'edit',resources:['src/billing/invoice.ts'],save:[],metadata:{}});
    // A real server keeps a pending v2 request visible on its per-session endpoint.
    stub.state.pending.push({id:'per_v2',sessionID:'s1',action:'edit',resources:['src/billing/invoice.ts'],save:[],metadata:{}});
    await new Promise(r=>setTimeout(r,60));
    let row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'waiting');
    assert.equal(row.review,'edit request\nsrc/billing/invoice.ts');
    // The legacy /permission list never contains v2 requests; repeated polls must not drop it.
    for(let i=0;i<4;i++){clock+=2100;await monitor.tick();}
    row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'waiting','still-pending v2 request vanished while polling');
    await monitor.action(row.id,'approve','per_v2');
    assert.deepEqual(stub.state.posts.find(p=>p.path==='/api/session/s1/permission/per_v2/reply'),{path:'/api/session/s1/permission/per_v2/reply',body:{reply:'once'}});
    assert.equal(stub.state.posts.find(p=>p.path==='/permission/per_v2/reply'),undefined);
    await new Promise(r=>setTimeout(r,60));
    row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'running');
  }finally{monitor.close();await stub.close();}
});

test('legacy requests resolved elsewhere disappear on the next poll',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'idle'}},pending:[{id:'per_7',sessionID:'s1',permission:'bash',patterns:['x'],metadata:{}}]});
  const port=await stub.listen();
  let clock=Date.now();
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(monitor.rows().find(r=>r.session_id==='s1').state,'waiting');
    stub.state.pending=stub.state.pending.filter(p=>p.id!=='per_7');
    clock+=2100;
    await monitor.tick();
    const row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'idle','worked-in session must stay after its request is resolved elsewhere');
    assert.deepEqual(row.actions,['continue','focus']);
  }finally{monitor.close();await stub.close();}
});

test('reject replies with reject and stop aborts the running turn',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'busy'}},pending:[{id:'per_9',sessionID:'s1',permission:'edit',patterns:['src/**'],metadata:{}}]});
  const port=await stub.listen();
  let clock=Date.now();
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    let row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'waiting');
    await monitor.action(row.id,'reject','per_9');
    assert.deepEqual(stub.state.posts.find(p=>p.path==='/permission/per_9/reply'),{path:'/permission/per_9/reply',body:{reply:'reject'}});
    await monitor.action(row.id,'stop','ses:s1@'+port);
    assert.deepEqual(stub.state.posts.find(p=>p.path==='/session/s1/abort'),{path:'/session/s1/abort',body:{}});
    clock+=2100;
    await monitor.tick();
    row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'idle');
    await monitor.action(row.id,'continue','ses:s1@'+port);
    const prompt=stub.state.posts.find(p=>p.path==='/session/s1/prompt_async');
    assert.deepEqual(prompt.body,{parts:[{type:'text',text:'Continue'}]});
  }finally{monitor.close();await stub.close();}
});

test('stale tokens are refused and vanished servers drop their rows',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'idle'}},pending:[{id:'per_5',sessionID:'s1',permission:'bash',patterns:['x'],metadata:{}}]});
  let port=await stub.listen();
  let clock=Date.now();
  const listener=async()=>[{address:'127.0.0.1',port,pid:4242}];
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,listener);
  try{
    await monitor.tick();
    await assert.rejects(()=>monitor.action(`oc:${port}:s1`,'approve','per_wrong'),/request has changed/);
    await stub.close();
    port=-1; // discovery no longer reports the server
    clock+=11000;
    await monitor.tick();
    await new Promise(r=>setTimeout(r,50));
    assert.equal(monitor.rows().length,0);
  }finally{monitor.close();}
});

test('v2 permissions pending before startup are discovered by polling',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'busy'}},
    pending:[{id:'per_early',sessionID:'s1',action:'edit',resources:['src/a.ts'],save:[],metadata:{}}]});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    const row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'waiting','v2 request pending before connect was not discovered');
    assert.equal(row.review,'edit request\nsrc/a.ts');
    await monitor.action(row.id,'approve','per_early');
    assert.deepEqual(stub.state.posts.find(p=>p.path==='/api/session/s1/permission/per_early/reply'),{path:'/api/session/s1/permission/per_early/reply',body:{reply:'once'}});
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(monitor.rows().find(r=>r.session_id==='s1').state,'running');
  }finally{monitor.close();await stub.close();}
});

test('v2 requests resolved elsewhere are dropped by the per-session list',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'busy'}}});
  const port=await stub.listen();
  let clock=Date.now();
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('permission.v2.asked',{id:'per_gone',sessionID:'s1',action:'bash',resources:['npm run build'],save:[],metadata:{}});
    stub.state.pending.push({id:'per_gone',sessionID:'s1',action:'bash',resources:['npm run build'],save:[],metadata:{}});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(monitor.rows().find(r=>r.session_id==='s1').state,'waiting');
    stub.state.pending=stub.state.pending.filter(p=>p.id!=='per_gone'); // resolved in the TUI, no event seen
    clock+=2100;
    await monitor.tick();
    const row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.state,'running');
    assert.deepEqual(row.actions,['stop','focus']);
  }finally{monitor.close();await stub.close();}
});

test('session events respect the child and archived filters used by polling',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{}});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('session.updated',{info:{id:'kid',parentID:'s1',title:'subagent',directory:'C:\\dev\\x',time:{created:2,updated:Date.now()}}});
    stub.emit('message.updated',{info:{sessionID:'kid'}});
    stub.emit('session.updated',{info:{id:'boxed',title:'archived',directory:'C:\\dev\\y',time:{created:2,updated:Date.now(),archived:3}}});
    stub.emit('message.updated',{info:{sessionID:'boxed'}});
    stub.emit('session.updated',{info:{id:'s2',title:'New session',directory:'C:\\dev\\s2',model:{id:'gpt-5',providerID:'openai'},time:{created:2,updated:Date.now()+1000}}});
    stub.emit('message.updated',{info:{sessionID:'s2'}});
    await new Promise(r=>setTimeout(r,60));
    const ids=monitor.rows().map(r=>r.session_id);
    assert.ok(!ids.includes('kid'),'child session leaked in via event');
    assert.ok(!ids.includes('boxed'),'archived session leaked in via event');
    const added=monitor.rows().find(r=>r.session_id==='s2');
    assert.equal(added.label,'New session');
    assert.equal(added.opencode.model,'openai/gpt-5');
  }finally{monitor.close();await stub.close();}
});

test('offline OpenCode entries can be selected on the PC while staying out of pad browsing',()=>{
  const row={id:'oc:4096:s1',session_id:'s1',label:'Fix login bug',state:'offline',reason:'Offline',detail:'Cannot reach OpenCode',project:'C:\\dev\\app',actions:['focus'],control_token:'ses:s1@4096',review:'',control_hint:'OpenCode offline · http://127.0.0.1:4096',source:'opencode',opencode:{connected:false,url:'http://127.0.0.1:4096',port:4096,version:'1.19.2'}};
  const agent={id:'agent',session_id:'agent',label:'Agent',state:'waiting',reason:'Approval',detail:'',project:'',actions:['approve'],control_token:'request',review:'Run tests',control_hint:''};
  const c=new Controller();
  c.update({rows:[agent,row],connected:false,error:''});
  assert.equal(c.rows.length,1);
  c.select('oc:4096:s1');
  assert.equal(c.selected,'oc:4096:s1');
  assert.equal(c.row?.state,'offline');
  c.update({rows:[agent,row],connected:false,error:''});
  assert.equal(c.selected,'oc:4096:s1','selection to an offline entry is dropped by refreshes');
  const svg=displaySvg(c);
  assert.match(svg,/OFFLINE/);
  assert.match(svg,/OPENCODE/);
  assert.doesNotMatch(svg,/NEEDS YOU/);
  c.select('agent');
  assert.equal(c.selected,'agent');
  c.rotate(1);
  assert.equal(c.selected,'agent','knob browsing skips offline entries');
});

test('stale history stays hidden until the session works in the window',async()=>{
  const stub=stubServer({sessions:[
    session('dust',{title:'Old greeting',updated:Date.now()-72*3600000}),
    session('live',{title:'Busy one',updated:Date.now()-72*3600000}),
    session('fresh',{title:'Recent work',updated:Date.now()-3600000})],
    statuses:{live:{type:'busy'}}});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    assert.equal(monitor.rows().length,0,'database history appeared without any activity');
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'live'}});
    await new Promise(r=>setTimeout(r,60));
    const ids=monitor.rows().map(r=>r.session_id);
    assert.deepEqual(ids,['live'],'activity alone must decide visibility, never recency');
  }finally{monitor.close();await stub.close();}
});

test('closing and reopening a window resets its session list',async()=>{
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{}});
  let port=await stub.listen();
  let clock=Date.now();
  const listener=async()=>[{address:'127.0.0.1',port,pid:4242}];
  const monitor=new OpenCodeMonitor(()=>{},()=>clock,listener);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    assert.equal(monitor.rows().length,1);
    await stub.close();
    port=-1;
    clock+=11000;
    await monitor.tick();
    assert.equal(monitor.rows().length,0,'closing the window cleared its sessions');
    // A new window in the same project: the database still knows session s1,
    // but nothing worked in this window yet, so nothing may be listed.
    const stub2=stubServer({sessions:[session('s1',{updated:Date.now()}),session('s2',{title:'Fresh work',updated:Date.now()})],statuses:{}});
    port=await stub2.listen();
    clock+=11000;
    await monitor.tick();
    assert.equal(monitor.rows().length,0,'a new window does not resurrect old sessions');
    await stub2.sseConnected;
    stub2.emit('session.created',{info:{id:'s2',title:'Fresh work',directory:'C:\\dev\\x',time:{created:2,updated:Date.now()}}});
    await new Promise(r=>setTimeout(r,60));
    await monitor.tick();
    const rows=monitor.rows();
    assert.equal(rows.length,1);
    assert.equal(rows[0].session_id,'s2','the new window shows only its own new session');
    await stub2.close();
  }finally{monitor.close();}
});

test('the same session on two servers appears once, on the live instance',async()=>{
  const make=port=>stubServer({sessions:[session('shared',{title:'One session',updated:Date.now()})],statuses:{shared:{type:'busy'}}});
  const live=make(),dead=make();
  const livePort=await live.listen(),deadPort=await dead.listen();
  // The second server also knows the session but has no live status or activity for it.
  dead.state.statuses={};
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port:livePort,pid:1},{address:'127.0.0.1',port:deadPort,pid:2}]);
  try{
    await monitor.tick();
    await live.sseConnected;
    live.emit('message.updated',{info:{sessionID:'shared'}});
    await new Promise(r=>setTimeout(r,60));
    const rows=monitor.rows();
    const shared=rows.filter(r=>r.session_id==='shared');
    assert.equal(shared.length,1,'duplicate session rows across servers');
    assert.equal(shared[0].state,'running','kept the stale idle copy instead of the live one');
    assert.equal(shared[0].opencode.port,livePort);
  }finally{monitor.close();await live.close();await dead.close();}
});

test('permission presets map to rulesets and back honestly',()=>{
  const {permissionRuleset,permissionMode}=require('../dist/main/opencode');
  assert.deepEqual(permissionRuleset('Auto'),[]);
  assert.deepEqual(permissionRuleset('Read-only'),[
    {permission:'edit',pattern:'*',action:'deny'},{permission:'bash',pattern:'*',action:'ask'},
    {permission:'external_directory',pattern:'*',action:'ask'},{permission:'external_directory',pattern:'**',action:'ask'}]);
  assert.deepEqual(permissionRuleset('No prompts'),[
    {permission:'bash',pattern:'*',action:'allow'},{permission:'edit',pattern:'*',action:'allow'},
    {permission:'external_directory',pattern:'*',action:'deny'}]);
  assert.deepEqual(permissionRuleset('YOLO / Full access'),[
    {permission:'bash',pattern:'*',action:'allow'},{permission:'edit',pattern:'*',action:'allow'},
    {permission:'external_directory',pattern:'*',action:'allow'},{permission:'external_directory',pattern:'**',action:'allow'}]);
  assert.throws(()=>permissionRuleset('Nonsense'));
  for(const mode of ['Read-only','Auto','No prompts','YOLO / Full access'])assert.equal(permissionMode(permissionRuleset(mode)),mode);
  assert.equal(permissionMode(undefined),'Auto');
  assert.equal(permissionMode([]),'Auto');
  assert.equal(permissionMode([{permission:'bash',pattern:'git *',action:'allow'}]),'Custom');
  assert.equal(permissionMode([{permission:'edit',pattern:'**',action:'deny'}]),'Custom');
  assert.equal(permissionMode([{permission:'bash',pattern:'*',action:'deny'},{permission:'edit',pattern:'*',action:'deny'},{permission:'external_directory',pattern:'*',action:'deny'}]),'Custom');
});

test('permission presets apply per session with honest readback',async()=>{
  const {permissionRuleset,permissionMode}=require('../dist/main/opencode');
  const stub=stubServer({sessions:[session('s1',{updated:Date.now()})],statuses:{s1:{type:'idle'}}});
  const port=await stub.listen();
  const monitor=new OpenCodeMonitor(()=>{},()=>Date.now(),async()=>[{address:'127.0.0.1',port,pid:4242}]);
  try{
    await monitor.tick();
    await stub.sseConnected;
    stub.emit('message.updated',{info:{sessionID:'s1'}});
    await new Promise(r=>setTimeout(r,60));
    const rowId=`oc:${port}:s1`;
    let row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.settings.mode,'Auto');
    await monitor.setPermission(rowId,'No prompts',`perm:${port}:s1`);
    assert.deepEqual(stub.state.sessions.find(s=>s.id==='s1').permission,permissionRuleset('No prompts'));
    await monitor.tick();
    row=monitor.rows().find(r=>r.session_id==='s1');
    assert.equal(row.settings.mode,'No prompts','row mode did not follow the applied ruleset');
    await assert.rejects(()=>monitor.setPermission(rowId,'Read-only','perm:wrong'),/stale/);
    await assert.rejects(()=>monitor.setPermission(rowId,'Nonsense',`perm:${port}:s1`),/Unknown permission mode/);
    // A server that reports something else than what was asked is treated as a failure.
    stub.state.sessions.find(s=>s.id==='s1').permission=permissionRuleset('Read-only');
    await monitor.setPermission(rowId,'YOLO / Full access',`perm:${port}:s1`);
    assert.equal(monitor.rows().find(r=>r.session_id==='s1').settings.mode,'YOLO / Full access');
  }finally{monitor.close();await stub.close();}
});

test('opencode rows expose Permission mode but never Model & Effort',()=>{
  const row={id:'oc:4096:s1',session_id:'s1',label:'Fix login bug',state:'idle',reason:'Idle',detail:'',project:'C:\\dev\\app',actions:['continue','focus'],control_token:'ses:s1@4096',review:'',control_hint:'OpenCode 1.19.2 · http://127.0.0.1:4096',settings:{mode:'Read-only'},settings_token:'perm:4096:s1',source:'opencode',opencode:{connected:true,url:'http://127.0.0.1:4096',port:4096,version:'1.19.2',model:'anthropic/claude-sonnet-4-5'}};
  const c=new Controller();
  c.update({rows:[row],connected:false,error:''});
  assert.match(c.menu.join('|'),/Permission mode/);
  assert.equal(c.canChooseModel,false);
  assert.doesNotMatch(c.menu.join('|'),/Model & Effort/);
  c.press(); // details
  c.cursor=c.menu.indexOf('Permission mode');
  c.press(); // settings page, cursor preselects Read-only
  assert.equal(c.page,'settings');
  assert.equal(c.cursor,0);
  c.cursor=2; // No prompts
  c.press(); // confirm
  assert.equal(c.page,'confirm');
  const intent=c.press();
  assert.deepEqual(intent,{method:'opencode-settings',params:{id:row.id,session_id:'s1',mode:'No prompts',token:'perm:4096:s1'}});
});

test('controller routes opencode intents and shows model on the LCD',()=>{
  const row={id:'oc:4096:s1',session_id:'s1',label:'Fix login bug',state:'waiting',reason:'Approval needed',detail:'',project:'C:\\dev\\app',actions:['approve','reject','stop','focus'],control_token:'per_1',review:'bash request\nnpm test',control_hint:'OpenCode 1.19.2 · http://127.0.0.1:4096',settings:{mode:'Read-only'},settings_token:'perm:4096:s1',source:'opencode',opencode:{connected:true,url:'http://127.0.0.1:4096',port:4096,version:'1.19.2',model:'anthropic/claude-sonnet-4-5'}};
  const c=new Controller();
  c.update({rows:[row],connected:false,error:''});
  assert.equal(c.row.id,row.id);
  assert.deepEqual(c.key(1),{method:'opencode-action',params:{id:row.id,session_id:'s1',verb:'focus',token:'per_1'}});
  c.markDisplayed('oc:4096:s1','s1','per_1');
  assert.deepEqual(c.key(0),{method:'opencode-action',params:{id:row.id,session_id:'s1',verb:'approve',token:'per_1'}});
  assert.equal(modelLabel(row,{rows:[],connected:false,error:''}),'claude-sonnet-4-5');
  assert.match(c.menu.join('|'),/Reject request/);
  assert.doesNotMatch(c.menu.join('|'),/Model & Effort/);
  const svg=displaySvg(c);
  assert.match(svg,/claude-sonnet-4-5 — OPENCODE/);
  assert.match(svg,/Read-only/);
  assert.match(svg,/NEEDS YOU/);
  c.update({rows:[{...row,opencode:{...row.opencode,connected:false}}],connected:false,error:''});
  assert.equal(c.rows.length,0);
});

