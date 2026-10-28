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

test('direct input suppresses keyboard output while preserving and restoring encoder flags',async()=>{
 const d=new EventEmitter(),writes=[],entries=new Map();d.bulk={write:b=>{writes.push(b);entries.set(b[7],Buffer.from(b.subarray(8,64)));}};
 for(const index of [13,14,15]){const entry=Buffer.alloc(56,7);entry.writeUInt32LE(0x201,0);entry.writeUInt32LE(0,16);entries.set(index,entry);}
 const originals=new Map([...entries].map(([i,b])=>[i,Buffer.from(b)]));
 const p=new XpadProtocol(d);p.readKeyInfo=async i=>Buffer.from(entries.get(i));
 await p.remapKnob(true);
 for(const [index,entry] of entries){assert.deepEqual(entry.subarray(0,16),originals.get(index).subarray(0,16));assert.deepEqual(entry.subarray(20,32),Buffer.alloc(12));assert.deepEqual(entry.subarray(32),originals.get(index).subarray(32));}
 await p.restoreKeys();for(const [i,b] of originals)assert.deepEqual(entries.get(i),b);
 assert.equal(writes.every(b=>b[6]===0x10),true);
});
