// Real-device readback verification; never sends agent actions or settings.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {XpadDevice}=require('../dist/main/device/hid');
const {XpadProtocol}=require('../dist/main/device/protocol');
const {Controller}=require('../dist/main/controller');
const {displaySvg,rgb565}=require('../dist/main/display');
const device=new XpadDevice(), protocol=new XpadProtocol(device);
function read(cmd,payload=Buffer.alloc(0),index=0){return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{device.bulk?.removeListener('data',onData);reject(Error('Readback timed out'));},2000);
 function onData(b){if(b[0]!==0x22||b[6]!==cmd||b[7]!==index)return;clearTimeout(timer);device.bulk.removeListener('data',onData);resolve(b.subarray(8,8+b.readUInt16LE(4)-4));}
 device.bulk.on('data',onData);device.bulk.write(protocol.buildPacket(cmd,payload,index));
});}
const deadline=setTimeout(()=>{console.error('Device not ready');device.stop();process.exitCode=1;},10000);
protocol.onReady=()=>{void(async()=>{
 clearTimeout(deadline);
 const results={screen:'240x135',keyRemap:false,knob:false,lcd:false,rgb:false,restored:false};
 let originals=[];
 try{
  const indices=[0,1,2,13,14,15];
  for(const i of indices)originals.push({index:i,entry:await read(0x10,Buffer.alloc(0),i)});
  await protocol.remapPadKeys([0x68,0x69,0x6a].map(key=>({key,mod:0})));
  for(let i=0;i<3;i++){const k=await read(0x10,Buffer.alloc(0),i);assert.equal(k[20],0);assert.equal(k[21],0x68+i);}
  results.keyRemap=true;
  await protocol.remapKnob();
  for(const [i,key] of [[13,0x6d],[14,0x6c],[15,0x6b]]){const k=await read(0x10,Buffer.alloc(0),i);assert.equal(k.readUInt32LE(16),0);assert.equal(k[21],key);}
  results.knob=true;
  const c=new Controller();const frame=await rgb565(displaySvg(c));await protocol.drawLcdFrame(frame);
  const screen=await read(0x25,Buffer.alloc(4));assert.deepEqual(screen.subarray(4),frame.subarray(0,screen.length-4));results.lcd=true;
  protocol.setLeds(Array.from({length:13},()=>({r:15,g:75,b:55})));
  await new Promise(resolve=>setTimeout(resolve,100));
  const leds=await read(0x27);assert.equal(leds.length,52);for(let i=0;i<13;i++)assert.deepEqual([...leds.subarray(i*4,i*4+3)],[15,75,55]);results.rgb=true;
 }finally{
  await protocol.restoreKeys();
  for(const original of originals)assert.deepEqual(await read(0x10,Buffer.alloc(0),original.index),original.entry);
  results.restored=true;device.stop();
  fs.mkdirSync('work',{recursive:true});fs.writeFileSync('work/hardware-check.json',JSON.stringify(results,null,2));console.log(results);
 }
})().catch(e=>{console.error(e);device.stop();process.exitCode=1;});};
device.start();
