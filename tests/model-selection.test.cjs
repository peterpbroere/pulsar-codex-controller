const {test}=require('node:test'),assert=require('node:assert/strict');
const {Controller,effortLabel,modelLabel}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');
const models=[{id:'model-a',label:'Model A',efforts:['low','high','ultra'],defaultEffort:'low'},{id:'model-b',label:'Model B',efforts:['medium','high'],defaultEffort:'medium'}];
const row=(id='a')=>({id,session_id:id,label:'Agent '+id,state:'running',reason:'Working',detail:'',project:'C:/dev',actions:['stop','focus'],control_token:'control',review:'',control_hint:'',settings:{model:'model-a',effort:'ultra'},settings_token:'settings-a'});
const setup=()=>{const c=new Controller();c.update({rows:[row(),row('b')],connected:true,error:'',models,models_token:'catalog'});return c;};
test('Model and Effort appear in the pad menu and header using selected-agent values',()=>{
 const c=setup();assert.ok(c.menu.includes('Model'));assert.ok(c.menu.includes('Effort'));assert.match(displaySvg(c),/Model A · Ultra/);
 c.snapshot.rows[1].settings={model:'model-b',effort:'medium'};c.select('b');assert.match(displaySvg(c),/Model B · Medium/);
 assert.equal(modelLabel(c.row,c.snapshot),'Model B');assert.equal(effortLabel(null),'Default');assert.equal(effortLabel(undefined),'Unknown');
});
test('model selection reviews unsupported effort fallback before a second knob press applies it',()=>{
 const c=setup();c.press();c.cursor=c.menu.indexOf('Model');c.press();assert.equal(c.page,'model');c.rotate(1);
 assert.equal(c.press(),undefined);assert.equal(c.page,'confirm');assert.equal(c.confirm.model,'model-b');assert.equal(c.confirm.effort,'medium');assert.match(displaySvg(c),/Effort: Medium/);
 assert.deepEqual(c.press(),{method:'configuration',params:{id:'a',session_id:'a',kind:'model',model:'model-b',effort:'medium',token:'settings-a',catalog_token:'catalog'}});
});
test('switching models preserves an effort supported by both models',()=>{
 const c=setup();c.row.settings.effort='high';c.openConfiguration('model');c.rotate(1);c.press();assert.equal(c.confirm.effort,'high');
});
test('effort picker contains only the selected model supported values and can be cancelled',()=>{
 const c=setup();c.openConfiguration('effort');assert.equal(c.cursor,2);assert.equal(c.pickerLabels.length,4);c.rotate(1);assert.equal(c.pickerLabels[c.cursor],'Back');c.press();assert.equal(c.page,'agent');
 c.openConfiguration('effort');c.rotate(-1);c.press();assert.equal(c.confirm.effort,'high');c.back();assert.equal(c.confirm,null);assert.equal(c.page,'agent');
});
test('confirmation retains exact agent, settings and catalog revisions when data refreshes',()=>{
 const c=setup();c.openConfiguration('effort');c.press();c.snapshot={...c.snapshot,rows:[{...row(),settings_token:'new-settings'},row('b')],models_token:'new-catalog'};
 const intent=c.press();assert.equal(intent.params.token,'settings-a');assert.equal(intent.params.catalog_token,'catalog');assert.equal(intent.params.session_id,'a');
});
test('unavailable catalogs disable selection and opening settings never approves a request',()=>{
 const c=setup();c.row.actions.push('approve');c.markDisplayed('a','a','control');c.openConfiguration('model');assert.equal(c.key(0),undefined);
 c.snapshot.models=[];c.snapshot.models_token=null;c.back();c.openConfiguration('model');assert.equal(c.page,'agent');assert.match(c.notice,/unavailable/);assert.ok(!c.menu.includes('Model'));
});
