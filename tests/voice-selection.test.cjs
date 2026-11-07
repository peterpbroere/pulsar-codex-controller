const {test}=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../dist/main/controller');
const {VoiceSession}=require('../dist/main/voice-session');
const {displaySvg}=require('../dist/main/display');
const snapshot=voices=>({connected:true,error:'',rows:[],voices});
test('voice picker uses native choices and stores selection for next session without enabling playback',()=>{
 const c=new Controller();c.update(snapshot(['cove','juniper']));c.toggleGlobal();c.cursor=4;c.press();
 assert.equal(c.page,'voice');assert.deepEqual(c.pickerLabels,['Codex default','Cove','Juniper','Back']);
 assert.match(displaySvg(c),/NEXT SESSION/);c.rotate(1);c.rotate(1);c.press();
 assert.equal(c.preferences.voiceName,'juniper');assert.equal(c.preferences.spokenReplies,false);assert.equal(c.page,'global');
 c.press();c.rotate(-1);c.press();assert.equal(c.preferences.voiceName,'cove');
});
test('back and + cancel voice selection without modifying preferences',()=>{
 const c=new Controller();c.update(snapshot(['cove']));c.setVoiceName('cove');c.toggleGlobal();c.cursor=4;c.press();
 c.rotate(-1);c.cancelOrBack();assert.equal(c.preferences.voiceName,'cove');assert.equal(c.page,'global');
 c.press();c.toggleGlobal();assert.equal(c.page,'agent');assert.equal(c.preferences.voiceName,'cove');
});
test('picker keeps displayed choices stable and refuses removed choices; default remains usable offline',()=>{
 const c=new Controller();c.update(snapshot(['cove','juniper']));c.toggleGlobal();c.cursor=4;c.press();c.rotate(1);
 c.update(snapshot(['juniper']));assert.equal(c.pickerLabels[1],'Cove');c.press();assert.equal(c.page,'voice');assert.match(c.notice,/unavailable/);
 c.cancelOrBack();c.setVoiceName('');c.update(snapshot([]));c.cursor=4;c.press();assert.deepEqual(c.pickerLabels,['Codex default','Back']);c.press();assert.equal(c.preferences.voiceName,'');
 c.loadPreferences({voiceName:'../../bad'});assert.equal(c.preferences.voiceName,'');
});
test('chosen voice is captured at start and changing preference cannot restart an active conversation',async()=>{
 const requests=[],audio={start:async()=> 'offer',answer:async()=>{},stop:async()=>{}};
 const session=new VoiceSession(audio,async(method,params)=>{requests.push([method,params]);return {};},()=>{});
 const row={id:'row',session_id:'thread',label:'Test',settings_token:'token'};
 await session.toggle(row,true,'','juniper');assert.equal(requests[0][1].voice_name,'juniper');
 await session.toggle(row,true,'','cove');assert.equal(requests.filter(r=>r[0]==='voice-start').length,1);
});
