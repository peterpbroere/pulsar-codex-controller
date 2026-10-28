const {test}=require('node:test'),assert=require('node:assert/strict');
const {Controller,effortLabel,modelLabel}=require('../dist/main/controller');
const {displaySvg}=require('../dist/main/display');
const models=[{id:'model-a',label:'Model A',efforts:['low','high','ultra'],defaultEffort:'low'},{id:'model-b',label:'Model B',efforts:['medium','high'],defaultEffort:'medium'}];
const row=(id='a')=>({id,session_id:id,label:'Agent '+id,state:'running',reason:'Working',detail:'',project:'C:/dev',actions:['stop','focus'],control_token:'control',review:'',control_hint:'',settings:{model:'model-a',effort:'ultra'},settings_token:'settings-a'});
const setup=()=>{const c=new Controller();c.update({rows:[row(),row('b')],connected:true,error:'',models,models_token:'catalog'});return c;};
test('one combined entry and current Model and Effort appear for the selected agent',()=>{
 const c=setup();assert.ok(c.menu.includes('Model & Effort'));assert.ok(!c.menu.includes('Effort'));assert.match(displaySvg(c),/Model A · Ultra/);
 c.snapshot.rows[1].settings={model:'model-b',effort:'medium'};c.select('b');assert.match(displaySvg(c),/Model B · Medium/);
 assert.equal(modelLabel(c.row,c.snapshot),'Model B');assert.equal(effortLabel(null),'Default');assert.equal(effortLabel(undefined),'Unknown');
});
test('choose model then supported effort then review both before applying',()=>{
 const c=setup();c.press();c.cursor=c.menu.indexOf('Model & Effort');c.press();assert.equal(c.page,'model');c.rotate(1);
 assert.equal(c.press(),undefined);assert.equal(c.page,'effort');assert.deepEqual(c.effortChoices,['medium','high']);assert.equal(c.cursor,0);assert.equal(c.confirm,null);
 assert.match(displaySvg(c),/Model B/);assert.match(displaySvg(c),/2 \/ 2/);
 assert.equal(c.press(),undefined);assert.equal(c.page,'confirm');assert.equal(c.confirm.model,'model-b');assert.equal(c.confirm.effort,'medium');assert.match(displaySvg(c),/Effort: Medium/);
 assert.deepEqual(c.press(),{method:'configuration',params:{id:'a',session_id:'a',kind:'model',model:'model-b',effort:'medium',token:'settings-a',catalog_token:'catalog'}});
});
test('a compatible current effort is initially highlighted but any supported effort can be chosen',()=>{
 const c=setup();c.row.settings.effort='high';c.openConfiguration();c.rotate(1);c.press();assert.equal(c.page,'effort');assert.equal(c.cursor,1);
 c.rotate(-1);c.press();assert.equal(c.confirm.effort,'medium');
});
test('Back in effort picker returns to model selection without applying anything',()=>{
 const c=setup();c.openConfiguration();c.press();assert.equal(c.page,'effort');assert.equal(c.cursor,2);assert.equal(c.pickerLabels.length,4);c.rotate(1);assert.equal(c.pickerLabels[c.cursor],'Back');
 assert.equal(c.press(),undefined);assert.equal(c.page,'model');assert.equal(c.confirm,null);assert.equal(c.configurationDraft,null);c.cancelOrBack();assert.equal(c.page,'agent');
});
test('confirmation retains exact agent, settings and catalog revisions when data refreshes',()=>{
 const c=setup();c.openConfiguration();c.press();c.snapshot={...c.snapshot,rows:[{...row(),settings_token:'new-settings'},row('b')],models_token:'new-catalog'};c.press();
 const intent=c.press();assert.equal(intent.params.token,'settings-a');assert.equal(intent.params.catalog_token,'catalog');assert.equal(intent.params.session_id,'a');
});
test('unavailable catalogs disable selection and opening settings never approves a request',()=>{
 const c=setup();c.row.actions.push('approve');c.markDisplayed('a','a','control');c.openConfiguration();assert.equal(c.key(0),undefined);
 c.snapshot.models=[];c.snapshot.models_token=null;c.back();c.openConfiguration();assert.equal(c.page,'agent');assert.match(c.notice,/unavailable/);assert.ok(!c.menu.includes('Model & Effort'));
});
test('physical Back revisits effort from review, then model, then cancels the flow',()=>{
 const c=setup();c.openConfiguration();c.rotate(1);c.press();c.rotate(1);c.press();assert.equal(c.confirm.effort,'high');
 c.cancelOrBack();assert.equal(c.page,'effort');assert.equal(c.cursor,1);assert.equal(c.confirm,null);
 c.cancelOrBack();assert.equal(c.page,'model');assert.equal(c.cursor,1);c.cancelOrBack();assert.equal(c.page,'agent');assert.equal(c.configurationDraft,null);
});
test('changing agents clears the staged selection',()=>{
 const c=setup();c.openConfiguration();c.rotate(1);c.press();c.select('b');assert.equal(c.page,'agent');assert.equal(c.configurationDraft,null);assert.equal(c.confirm,null);
});
test('models without effort options skip an empty picker and still require review',()=>{
 const c=setup();c.snapshot.models=[{id:'simple',label:'Simple',efforts:[],defaultEffort:null}];c.openConfiguration();assert.equal(c.press(),undefined);
 assert.equal(c.page,'confirm');assert.equal(c.confirm.effort,null);c.cancelOrBack();assert.equal(c.page,'model');
});
