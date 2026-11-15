const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {discoverModernConnection}=require('../dist/main/opencode2-discovery');

const listener={address:'127.0.0.1',port:28894,pid:35064};
const executable=path.join('C:',path.sep,'dev','opencode-v2','runtime','node_modules','@opencode','cli-windows-x64','bin','opencode.exe');
const stateRoot=path.join('C:',path.sep,'dev','opencode-v2','profile','state');
const servicePath=path.join(stateRoot,'opencode','service.json');
const record={id:'local-service',version:'2.2.6',url:'http://127.0.0.1:28894',pid:35064,password:'fixture-only-secret'};
const okInfo=()=>({ok:true,json:async()=>({pid:35064,version:'2.2.6'})});

test('finds a matching service record in a portable profile ancestor and authenticates /api/info',async()=>{
  const readPaths=[],requests=[];
  const connection=await discoverModernConnection(listener,executable,true,{
    env:{XDG_STATE_HOME:path.join('C:',path.sep,'unrelated','xdg')},
    homeDir:path.join('C:',path.sep,'Users','fixture'),
    readFile:async file=>{readPaths.push(file);if(file===servicePath)return JSON.stringify(record);throw Error('ENOENT');},
    fetch:async(url,init)=>{requests.push({url:String(url),init});return okInfo();},
  });
  assert.ok(readPaths.includes(servicePath));
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'http://127.0.0.1:28894/api/info');
  assert.equal(requests[0].init.headers.authorization,'Basic '+Buffer.from('opencode:fixture-only-secret').toString('base64'));
  assert.equal(requests[0].init.redirect,'error');
  assert.equal(connection.url,'http://127.0.0.1:28894');
  assert.equal(connection.version,'2.2.6');
  assert.equal(connection.pid,35064);
  assert.equal(connection.port,28894);
  assert.equal(connection.executablePath,executable);
  assert.equal(connection.tabFile,path.join(stateRoot,'opencode','latest','tui','tabs.json'));
  assert.equal(connection.hasClient,true);
});

test('tries only the XDG state and per-user service.json candidates when no portable record exists',async()=>{
  const reads=[];
  const xdg=path.join('C:',path.sep,'isolated','state');
  const home=path.join('C:',path.sep,'Users','fixture');
  const connection=await discoverModernConnection(listener,executable,false,{
    env:{XDG_STATE_HOME:xdg},homeDir:home,
    readFile:async file=>{reads.push(file);throw Error('ENOENT');},
    fetch:async()=>{throw Error('fetch must not run without a candidate record');},
  });
  assert.equal(connection,undefined);
  assert.deepEqual(reads.slice(0,2),[
    path.join(xdg,'opencode','service.json'),
    path.join(home,'.local','state','opencode','service.json'),
  ]);
  assert.ok(reads.every(file=>path.basename(file)==='service.json'));
});

test('rejects mismatched listener pid or record port before sending credentials',async t=>{
  for(const [name,badListener,badRecord] of [
    ['pid',{...listener,pid:77},record],
    ['port',listener,{...record,url:'http://127.0.0.1:28895'}],
  ]){
    await t.test(name,async()=>{
      let fetchCalls=0;
      const result=await discoverModernConnection(badListener,executable,true,{
        env:{},homeDir:'C:\\Users\\fixture',
        readFile:async file=>file===servicePath?JSON.stringify(badRecord):Promise.reject(Error('ENOENT')),
        fetch:async()=>{fetchCalls++;return okInfo();},
      });
      assert.equal(result,undefined);
      assert.equal(fetchCalls,0);
    });
  }
});

test('accepts only loopback http endpoints and a matching 2.x info response',async t=>{
  for(const [name,recordForTest,info] of [
    ['non-loopback URL',{...record,url:'http://192.168.1.8:28894'},{pid:35064,version:'2.2.6'}],
    ['https URL',{...record,url:'https://127.0.0.1:28894'},{pid:35064,version:'2.2.6'}],
    ['wrong info pid',record,{pid:7,version:'2.2.6'}],
    ['wrong info version',record,{pid:35064,version:'2.3.0'}],
    ['non-modern info version',record,{pid:35064,version:'1.19.2'}],
  ]){
    await t.test(name,async()=>{
      let fetchCalls=0;
      const result=await discoverModernConnection(listener,executable,false,{
        env:{},homeDir:'C:\\Users\\fixture',
        readFile:async file=>file===servicePath?JSON.stringify(recordForTest):Promise.reject(Error('ENOENT')),
        fetch:async()=>{fetchCalls++;return {ok:true,json:async()=>info};},
      });
      assert.equal(result,undefined);
      assert.equal(fetchCalls,name.includes('URL')?0:1);
    });
  }
});

test('rejects redirects, HTTP failures, invalid records, and malformed JSON',async t=>{
  for(const [name,source,fetcher] of [
    ['invalid record',JSON.stringify({...record,pid:'35064'}),async()=>{throw Error('must not fetch');}],
    ['malformed JSON','{',async()=>{throw Error('must not fetch');}],
    ['HTTP failure',JSON.stringify(record),async()=>({ok:false,status:401})],
    ['redirect error',JSON.stringify(record),async()=>{throw Error('redirect rejected');}],
  ]){
    await t.test(name,async()=>{
      const result=await discoverModernConnection(listener,executable,false,{
        env:{},homeDir:'C:\\Users\\fixture',
        readFile:async file=>file===servicePath?source:Promise.reject(Error('ENOENT')),
        fetch:fetcher,
      });
      assert.equal(result,undefined);
    });
  }
});
