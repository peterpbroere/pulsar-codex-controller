const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createMicrophoneSelector,syncSelect}=require('../ui/microphone-selector');

const devices=(...items)=>items.map(([id,label])=>({id,label}));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('device changes coalesce behind one in-flight read and stale results cannot win last',async()=>{
 const selector=createMicrophoneSelector(),first=deferred();let calls=0,active=0,maxActive=0;
 const load=()=>{calls++;active++;maxActive=Math.max(maxActive,active);if(calls===1)return first.promise.finally(()=>active--);active--;return Promise.resolve(devices(['new','New headset']));};
 const initial=selector.refresh(load,'startup');await new Promise(resolve=>setImmediate(resolve));
 const one=selector.refresh(load,'devicechange'),two=selector.refresh(load,'devicechange');
 first.resolve(devices(['old','Old headset']));await Promise.all([initial,one,two]);
 assert.equal(calls,2);assert.equal(maxActive,1);assert.deepEqual(selector.state().devices,devices(['new','New headset']));
});

test('normalizes aliases and duplicate IDs while retaining labels by device ID',async()=>{
 const selector=createMicrophoneSelector();
 await selector.refresh(()=>devices(['default','Default'],['communications','Comms'],['mic-1','Studio mic'],['mic-1','']), 'startup');
 assert.deepEqual(selector.state().devices,devices(['mic-1','Studio mic']));
 await selector.refresh(()=>devices(['mic-1','']), 'manual');
 assert.deepEqual(selector.state().devices,devices(['mic-1','Studio mic']));
 assert.deepEqual(selector.view('').options.map(option=>option.label),['Windows default input','Studio mic']);
});

test('saved missing input stays visible and Default remains selectable after unplug',async()=>{
 const selector=createMicrophoneSelector();
 await selector.refresh(()=>devices(['mic-a','Desk mic'],['mic-b','Headset']), 'startup');
 await selector.refresh(()=>devices(['mic-b','Headset']), 'devicechange');
 const view=selector.view('mic-a');
 assert.deepEqual(view.options.map(option=>option.value),['','mic-b','mic-a']);
 assert.equal(view.options[2].label,'Saved microphone unavailable');
 assert.equal(view.selected,'mic-a');
 assert.ok(view.note.includes('unavailable'));
 assert.equal(selector.view('').selected,'');
 assert.deepEqual(selector.state().devices,devices(['mic-b','Headset']));
});

test('empty or failed refresh retains named choices but confirmed empty change clears them',async()=>{
 const selector=createMicrophoneSelector();
 await selector.refresh(()=>devices(['mic-a','Desk mic']), 'startup');
 await selector.refresh(()=>devices(['mic-a','']), 'manual');
 assert.deepEqual(selector.state().devices,devices(['mic-a','Desk mic']));
 assert.equal(selector.state().source,'cached');assert.match(selector.view('').note,/temporarily unavailable/);
 await selector.refresh(()=>[], 'manual');
 assert.deepEqual(selector.state().devices,devices(['mic-a','Desk mic']));
 assert.equal(selector.state().source,'cached');assert.match(selector.view('').note,/last known/);
 await selector.refresh(()=>{throw Error('temporary IPC failure');},'manual');
 assert.deepEqual(selector.state().devices,devices(['mic-a','Desk mic']));
 assert.match(selector.view('').note,/temporary IPC failure/);
 let reads=0;await selector.refresh(()=>{reads++;return[];},'devicechange');
 assert.equal(reads,2);assert.equal(selector.state().source,'confirmed-empty');assert.deepEqual(selector.state().devices,[]);
 const saved=selector.view('mic-a');assert.deepEqual(saved.options.map(option=>option.value),['','mic-a']);
});

test('default and communications aliases collapse to the single default option',async()=>{
 const selector=createMicrophoneSelector();
 await selector.refresh(()=>devices(['default',''],['communications',''],['communications-default','']),'startup');
 const view=selector.view('communications');
 assert.deepEqual(view.options.map(option=>option.value),['','communications']);
 assert.equal(view.options[1].label,'Communications default');
 assert.equal(view.selected,'communications');
 assert.deepEqual(selector.view('default').options.map(option=>option.value),['']);
 assert.equal(view.source,'unverified');
});

test('saved communications alias is unavailable only when it is absent from enumeration',async()=>{
 const selector=createMicrophoneSelector();
 await selector.refresh(()=>devices(['communications','']),'startup');
 assert.equal(selector.view('communications').options[1].label,'Communications default');
 await selector.refresh(()=>devices(['mic','Studio mic']),'devicechange');
 assert.equal(selector.view('communications').options.at(-1).label,'Saved communications default unavailable');
});

test('selector renders only on option or saved-value changes and restores focus',async()=>{
 const selector=createMicrophoneSelector();await selector.refresh(()=>devices(['mic-a','Studio mic']),'startup');
 const select={dataset:{},options:[],value:'',replacements:0,focusCalls:0,replaceChildren(...options){this.options=options;this.replacements++;},focus(){this.focusCalls++;}};
 const makeOption=(label,value)=>({label,value});
 const first=selector.view('mic-a');assert.equal(syncSelect(select,first,{},makeOption),true);
 const noteOnly={...first,note:'temporary issue'};
 assert.equal(syncSelect(select,noteOnly,select,makeOption),false);
 assert.equal(select.replacements,1);assert.equal(select.value,'mic-a');assert.equal(select.focusCalls,0);
 await selector.refresh(()=>devices(['mic-a','Studio mic'],['mic-b','Headset']),'devicechange');
 assert.equal(syncSelect(select,selector.view('mic-a'),select,makeOption),true);
 assert.equal(select.replacements,2);assert.equal(select.focusCalls,1);
});
