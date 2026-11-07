const {test}=require('node:test'),assert=require('node:assert/strict');
const {VoiceSession}=require('../dist/main/voice-session');
const {PressGesture}=require('../dist/main/device/press-gesture');
const row={id:'one',session_id:'thread-one',label:'Agent one',settings_token:'settings'};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const calls=[],states=[];
 const audio={start:async(id,device)=>{calls.push(['capture',id,device]);return 'offer';},answer:async(...p)=>{calls.push(['answer',...p]);},stop:async id=>{calls.push(['release',id]);}};
 const voice=new VoiceSession(audio,async(method,p)=>{calls.push([method,p]);return {};},s=>states.push(s));
 return {voice,audio,calls,states};
}
test('tap and hold are mutually exclusive, delayed ticks and duplicate edges are safe',()=>{
 const g=new PressGesture();g.down(0);g.down(200);assert.deepEqual(g.up(699),['tap']);
 g.down(1000);assert.deepEqual(g.tick(1700),['hold']);assert.deepEqual(g.tick(3000),[]);assert.deepEqual(g.up(4000),[]);
 g.down(5000);assert.deepEqual(g.up(5700),['hold']);assert.deepEqual(g.up(5800),[]);
 g.down(6000);g.reset();assert.deepEqual(g.up(7000),[]);
});
test('voice pins selected agent, routes answer, and ending releases media before native stop',async()=>{
 const {voice,calls}=fixture();await voice.toggle(row,true,'mic');const id=voice.status.voiceId;
 assert.equal(voice.status.phase,'starting');assert.equal(voice.status.target.sessionId,row.session_id);
 voice.event({event:'voice',voice_id:id,method:'thread/realtime/sdp',params:{threadId:row.session_id,sdp:'answer'}});
 await flush();voice.audioState(id,'active');assert.equal(voice.status.phase,'active');
 await voice.toggle({...row,id:'two',session_id:'thread-two'},true);
 assert.equal(voice.status.phase,'idle');
 assert.equal(calls.filter(c=>c[0]==='voice-start').length,1);
 assert.ok(calls.findIndex(c=>c[0]==='release')<calls.findIndex(c=>c[0]==='voice-stop'));
 assert.deepEqual(calls.find(c=>c[0]==='answer'),['answer',id,'answer']);
});
test('stop while microphone permission is pending prevents native startup and stale callbacks',async()=>{
 const f=fixture(),pending=defer();f.audio.start=()=>pending.promise;
 const task=f.voice.toggle(row,true);const id=f.voice.status.voiceId;
 await f.voice.stop();pending.resolve('late offer');await task;
 f.voice.audioState(id,'active');assert.equal(f.voice.status.phase,'idle');
 assert.equal(f.calls.some(c=>c[0]==='voice-start'),false);
});
test('stop while native start is pending cleans up and cannot rearm microphone',async()=>{
 const f=fixture(),pending=defer();
 const voice=new VoiceSession(f.audio,async(method,p)=>{f.calls.push([method,p]);return method==='voice-start'?pending.promise:{};},()=>{});
 const task=voice.toggle(row,true);await flush();const id=voice.status.voiceId;
 await voice.stop();pending.resolve({});await task;voice.audioState(id,'active');
 assert.equal(voice.status.phase,'idle');assert.equal(f.calls.filter(c=>c[0]==='voice-stop').length,1);
});
test('wrong voice/thread events ignored, errors release mic and preserve useful error',async()=>{
 const f=fixture();await f.voice.toggle(row,true);const id=f.voice.status.voiceId;
 f.voice.event({event:'voice',voice_id:'old',method:'thread/realtime/error',params:{message:'old'}});
 f.voice.event({event:'voice',voice_id:id,method:'thread/realtime/error',params:{threadId:'other',message:'other'}});
 assert.equal(f.voice.status.phase,'starting');
 f.voice.event({event:'voice',voice_id:id,method:'thread/realtime/error',params:{threadId:row.session_id,message:'network failed'}});
 await flush();assert.equal(f.voice.status.phase,'error');assert.equal(f.voice.status.error,'network failed');
 assert.equal(f.calls.some(c=>c[0]==='release'),true);
});
test('disconnected and ComfyUI starts never capture audio; thread close stops live voice',async()=>{
 const f=fixture();await f.voice.toggle(row,false);await f.voice.toggle({...row,source:'comfyui'},true);
 assert.equal(f.calls.length,0);await f.voice.toggle(row,true);
 f.voice.event({event:'voice',voice_id:f.voice.status.voiceId,method:'thread/closed',params:{threadId:row.session_id}});
 await flush();assert.equal(f.voice.status.phase,'error');assert.equal(f.voice.running,false);
});
test('native spoken replies are displayed as text without overwriting the user transcript',async()=>{
 const f=fixture();await f.voice.toggle(row,true);const id=f.voice.status.voiceId;
 const event=(role,part,value)=>f.voice.event({event:'voice',voice_id:id,method:'thread/realtime/transcript/'+part,params:{threadId:row.session_id,role,[part==='done'?'text':'delta']:value}});
 event('user','done','Run the checks.');event('assistant','delta','Ready');event('assistant','done','Ready.');
 assert.equal(f.voice.status.transcript,'Run the checks.');assert.equal(f.voice.status.reply,'Ready.');
 assert.ok(f.voice.status.speakingUntil>Date.now());
 event('user','delta','Next prompt');assert.equal(f.voice.status.transcript,'Next prompt');assert.equal(f.voice.status.speakingUntil,0);
 await f.voice.stop();
});
