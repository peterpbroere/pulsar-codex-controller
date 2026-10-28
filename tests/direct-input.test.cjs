const {test}=require('node:test'),assert=require('node:assert/strict');
const {DirectInput}=require('../dist/main/device/direct-input');
const packet=hex=>Buffer.from(hex,'hex');
const report=(...pairs)=>{
 const b=Buffer.alloc(8+pairs.length);b[0]=0x21;b[6]=0xff;b.writeUInt16LE(4+pairs.length,4);Buffer.from(pairs).copy(b,8);
 let sum=0;for(let i=0;i<b.length;i+=2)sum=(sum+b.readUInt16LE(i))&0xffff;b.writeUInt16LE(sum,2);return b;
};
test('captured vendor presses select main buttons and knob without keyboard shortcuts',()=>{
 const input=new DirectInput();
 for(const [hex,action] of [['21004c690800ff0010001468','key1'],['21004c6b0800ff0010011469','key2'],['21004c6d0800ff001002146a','key3'],['21004c7b0800ff00100d146d','press']]){
  assert.deepEqual(input.update(packet(hex),1000),[action]);assert.deepEqual(input.update(packet(hex),1500),[]);
 }
});
test('captured encoder contact releases count exactly one completed turn in each direction',()=>{
 const input=new DirectInput();
 assert.deepEqual(input.update(packet('210037100600ff00110f')),[]);
 assert.deepEqual(input.update(packet('21004a1d0800ff00110e110e')),['next']);
 assert.deepEqual(input.update(packet('2100370f0600ff00110e')),[]);
 assert.deepEqual(input.update(packet('21004a1f0800ff00110f110f')),['previous']);
});
test('direct turns remain separate at high speed while held buttons and bounce do not repeat',()=>{
 const input=new DirectInput();
 assert.deepEqual(input.update(report(0x10,0),1000),['key1']);
 assert.deepEqual(input.update(report(0x10,0),1100),[]);
 input.update(report(0x11,0),1110);
 assert.deepEqual(input.update(report(0x10,0),1120),['key1']);
 input.update(report(0x11,0),1130);
 assert.deepEqual(input.update(report(0x10,0),1140),[]);
 for(let i=0;i<20;i++)assert.deepEqual(input.update(report(0x11,14,0x11,14),1200+i),['next']);
 input.reset();assert.deepEqual(input.update(report(0x10,0),1200),['key1']);
});
test('malformed reports, heartbeat and keyboard-output events cannot dispatch controls',()=>{
 const input=new DirectInput(),valid=report(0x10,0),bad=Buffer.from(valid);bad[2]^=1;
 for(const b of [Buffer.alloc(0),valid.subarray(0,9),bad,report(0x14,0),report(0xc0,0)])assert.deepEqual(input.update(b),[]);
 assert.deepEqual(input.update(valid),['key1']);
});
