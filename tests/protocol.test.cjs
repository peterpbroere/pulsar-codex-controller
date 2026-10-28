const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {XpadProtocol}=require('../dist/main/device/protocol');
test('vendor packets use the documented length, checksum and RAM-only commands',()=>{const p=new XpadProtocol(new EventEmitter());const packet=p.buildPacket(0x27,Buffer.alloc(52,1));assert.equal(packet.length,1024);assert.equal(packet[0],0x22);assert.equal(packet.readUInt16LE(4),56);let sum=0;const check=packet.readUInt16LE(2);packet.writeUInt16LE(0,2);for(let i=0;i<60;i+=2)sum=(sum+packet.readUInt16LE(i))&65535;assert.equal(sum,check);assert.equal(packet[6],0x27);});
test('key remapping preserves full original entry and restores it on quit',async()=>{const d=new EventEmitter(),writes=[];d.bulk={write:p=>writes.push(p)};const p=new XpadProtocol(d);const original=Buffer.alloc(56,7);original.writeUInt32LE(1,0);p.readKeyInfo=async()=>Buffer.from(original);await p.remapPadKeys([{mod:0,key:0x68}]);assert.equal(writes[0][8+21],0x68);await p.restoreKeys();assert.deepEqual(writes[1].subarray(8,64),original);assert.equal(writes.every(b=>b[6]===0x10),true);});
test('raw-button reader ignores unrelated and corrupt packets before the valid response',async()=>{
 const d=new EventEmitter();d.bulk=new EventEmitter();const p=new XpadProtocol(d);
 d.bulk.write=()=>{setImmediate(()=>{
  d.bulk.emit('data',p.buildPacket(0x25,Buffer.alloc(4)));
  const payload=Buffer.alloc(4);payload.writeUInt32LE(0x2ffff);
  const response=p.buildPacket(0x1e,payload),bad=Buffer.from(response);bad[2]^=1;
  d.bulk.emit('data',bad);d.bulk.emit('data',response);
 });};
 assert.equal(await p.readButtonState(),0x2ffff);assert.equal(d.bulk.listenerCount('data'),0);
});
