const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Controller}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');

const row=(id='agent',state='waiting')=>({id,session_id:id,label:`Session ${id}`,state,reason:'Needs approval',detail:'',project:'C:/work',actions:['approve','focus'],control_token:'token',review:'Command:\nFirst approval line\nSecond approval line\nThird approval line',control_hint:'',settings:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}}});
const setup=()=>{const c=new Controller();c.update({rows:[row(),row('other','running')],connected:true,error:''});c.voice={phase:'idle'};c.canStartVoice=true;return c;};

test('LCD shows voice target and end label across pages without covering approval preview',()=>{
 const c=setup();c.voice={phase:'active',voiceId:'voice-1',target:{id:'agent',sessionId:'agent',label:'Session agent'}};
 c.page='global';
 const svg=displaySvg(c);
 assert.match(svg,/GLOBAL SETTINGS/);
 assert.match(svg,/VOICE ACTIVE · Session agent/);
 c.page='agent';
 const approval=displaySvg(c);
 assert.match(approval,/END VOICE/);
 assert.match(approval,/First approval line/);
 assert.match(approval,/Second approval line/);
 assert.match(approval,/Third approval line/);
 assert.match(approval,/VOICE ACTIVE · Session agent/);
});

test('approval preview keeps all three lines visible above the voice strip',()=>{
 const c=setup();c.voice={phase:'active',target:{id:'agent',sessionId:'agent',label:'Session agent'}};
 const svg=displaySvg(c);
 const lineYs=[...svg.matchAll(/<text x="0" y="(\d+)"[^>]*>(First approval line|Second approval line|Third approval line)<\/text>/g)].map(m=>Number(m[1]));
 assert.deepEqual(lineYs,[11,24,37]);
 assert.match(svg,/VOICE ACTIVE/);
});

test('voice status remains pinned to its target while browsing another agent',()=>{
 const c=setup();c.voice={phase:'starting',target:{id:'agent',sessionId:'agent',label:'Session agent'}};
 c.select('other');c.page='details';
 const svg=displaySvg(c);
 assert.match(svg,/VOICE STARTING/);
 assert.match(svg,/Session agent/);
 assert.match(svg,/DETAILS/);
});

test('inactive voice errors stay visible and escaped for a clean retry',()=>{
 const c=setup();c.voice={phase:'error',target:{id:'agent',sessionId:'agent',label:'Microphone'},error:'<mic>'};
 const svg=displaySvg(c);
 assert.match(svg,/VOICE ERROR/);
 assert.match(svg,/&lt;mic&gt;/);
 assert.match(svg,/VOICE/);
});
