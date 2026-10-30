const $=id=>document.getElementById(id);
let current;
async function perform(action){try{await action();}catch(e){$('status').textContent=e.message;}}
function button(label,verb,enabled=true){const b=document.createElement('button');b.textContent=label;b.disabled=!enabled;b.onclick=()=>perform(()=>window.deck.action(verb));return b;}
function animate(v){
 const src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(v.svg);if($('lcd').getAttribute('src')!==src)$('lcd').src=src;
 const mascot=$('mascot-preview');mascot.hidden=!v.mascot;
 if(v.mascot&&mascot.getAttribute('src')!==v.mascot.image){mascot.src=v.mascot.image;mascot.alt=`${v.mascot.choice} · ${v.mascot.state}`;}
}
function render(v){
 current=v;
 $('connection').textContent=v.demo?'DEMO':v.snapshot.connected?'Codex connected':'Waiting for Codex';
 $('device').textContent=v.device.ready?'USB connected':v.device.connected?'Verifying protocol':'Not connected';
 $('count').textContent=v.snapshot.rows.length;
 $('connect-codex').disabled=v.busy||v.demo;
 const diagnostics=v.snapshot.diagnostics;
 $('setup-help').hidden=v.demo||v.snapshot.rows.some(r=>r.source!=='comfyui');
 $('setup-help').textContent=diagnostics&&!diagnostics.codex_installed?'Install Codex CLI, sign in with codex login, then restart this app.':diagnostics?.hooks_configured?'Hooks found. In Codex, run /hooks to review/trust them, then start or resume a session and send a prompt.':'Connect Codex to install the session-status hooks. Existing hooks are backed up and preserved.';
 animate(v);$('mascot-choice').value=v.preferences.mascot;$('mascot-choice').disabled=v.busy;
 const list=$('sessions');list.replaceChildren();
 for(const r of v.snapshot.rows){const offline=r.source==='comfyui'&&!r.comfy?.connected;const b=document.createElement('button');b.className='session'+(r.id===v.selected?' selected':'');b.disabled=v.busy;const name=document.createElement('strong');name.textContent=r.label;const state=document.createElement('span');state.textContent=(r.source==='comfyui'?'COMFYUI':'CODEX')+' · '+r.reason+(offline?' · Edit connection':'');state.className=r.state;b.append(name,state);b.onclick=()=>offline?editComfy(v.comfyConnections.find(c=>'comfy:'+c.id===r.id)):perform(()=>window.deck.select(r.id));list.append(b);}
 if(!v.snapshot.rows.length){const p=document.createElement('p');p.className='empty';p.textContent='Your participating Codex sessions appear here after their first prompt. Use Connect Codex to set up session discovery.';list.append(p);}
 const r=v.snapshot.rows.find(r=>r.id===v.selected);
 $('name').textContent=r?.label||'No sessions yet';$('project').textContent=r?.project||'';$('reason').textContent=r?.reason||'';
 if(r?.comfy?.running){const p=r.comfy,percent=x=>x?Math.round(x.value/x.max*100)+'%':'—';$('reason').textContent=`${r.reason}\nTotal: ${percent(p.total)}\n${p.node||'Current node'}: ${percent(p.progress)}`;}
 $('model-effort').textContent=r?.comfy?`${r.comfy.running} running · ${r.comfy.pending} queued`:r?`Model: ${v.modelLabel} · Effort: ${v.effortLabel}`:'';
 const actions=$('actions');actions.replaceChildren();
 for(const [verb,label] of [['focus','Open on PC'],['stop','Stop turn'],['continue','Continue']]) if(r?.actions.includes(verb)) actions.append(button(label,verb,!v.busy));
 if(r?.review)actions.append(button(r.comfy?'Activity':'Review request','review',!v.busy));
 if(r?.settings)actions.append(button('Permission mode','settings',!v.busy));
 if(v.canChooseModel)actions.append(button('Model & Effort','model',!v.busy));
 if(r?.comfy?.latest)actions.append(button('View image on pad','image',!v.busy));
 const latest=r?.comfy?.latest;$('generation').hidden=!latest;
 if(latest){if($('generation-image').getAttribute('src')!==latest.image)$('generation-image').src=latest.image;$('generation-caption').textContent='Latest completed image · '+latest.filename+(r.comfy.connected?'':' · offline');}
 $('comfy-management').hidden=!r?.comfy;$('edit-comfy').disabled=v.busy;$('remove-comfy').disabled=v.busy;$('add-comfy').disabled=v.busy||v.demo;
 const settings=r?.settings;$('settings').textContent=settings?`Approval: ${typeof settings.approvalPolicy==='string'?settings.approvalPolicy:JSON.stringify(settings.approvalPolicy)} · Sandbox: ${settings.sandboxPolicy?.type}\nChanges apply to subsequent turns.`:r?.settings_error||r?.control_hint||'';
 if(r?.comfy?.imageError)$('settings').textContent+='\n'+r.comfy.imageError;
 $('review-panel').hidden=v.page!=='details'||!v.review?.review;$('review').textContent=v.review?.review||'';
 $('review-title').textContent=r?.comfy?'Generation activity':'Pending request';$('approval-actions').hidden=!!r?.comfy;
 $('approve').disabled=v.busy||!v.canApprove;$('reject').disabled=v.busy||!v.review?.actions.includes('reject');
 document.querySelectorAll('[data-key]').forEach(b=>{const key=Number(b.dataset.key);b.disabled=v.busy||(key===0&&!v.canApprove)||(key===1&&!r?.actions.includes('focus'))||(key===2&&!v.snapshot.rows.some(r=>r.state==='waiting'||r.state==='error'));});
 $('status').textContent=v.notice||v.device.error||(r?.comfy?(r.comfy.connected?'ComfyUI connected · '+v.inputMode:'ComfyUI offline · check its URL or start the server'):v.snapshot.error)||(v.busy?'Working…':v.snapshot.connected?'Ready · '+v.inputMode:'Waiting for participating Codex sessions');
}
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>perform(()=>window.deck.key(Number(b.dataset.key))));
document.querySelectorAll('[data-control]').forEach(b=>b.onclick=()=>perform(()=>window.deck.control(b.dataset.control)));
$('back').onclick=()=>perform(()=>window.deck.back());
$('approve').onclick=()=>perform(()=>window.deck.action('approve'));
$('reject').onclick=()=>perform(()=>window.deck.action('reject'));
window.deck.onView(render);window.deck.view().then(render).catch(e=>$('status').textContent=e.message);
window.deck.onAnimation(animate);
$('mascot-choice').onchange=e=>perform(()=>window.deck.mascot(e.target.value));
$('connect-codex').onclick=()=>perform(()=>window.deck.setup());
let editingComfyId;
function editComfy(config){editingComfyId=config?.id;$('comfy-title').textContent=config?'Edit ComfyUI connection':'Add ComfyUI connection';$('comfy-name').value=config?.name||'';$('comfy-url').value=config?.url||'';$('comfy-result').textContent='';$('delete-comfy').hidden=!config;$('comfy-dialog').showModal();$('comfy-name').focus();}
const comfyValue=()=>({id:editingComfyId,name:$('comfy-name').value,url:$('comfy-url').value});
$('add-comfy').onclick=()=>editComfy();
$('edit-comfy').onclick=()=>editComfy(current.comfyConnections.find(c=>'comfy:'+c.id===current.selected));
$('close-comfy').onclick=()=>$('comfy-dialog').close();
$('comfy-form').onsubmit=async e=>{e.preventDefault();$('save-comfy').disabled=true;try{await window.deck.comfySave(comfyValue());$('comfy-dialog').close();}catch(e){$('comfy-result').textContent=e.message;}finally{$('save-comfy').disabled=false;}};
$('test-comfy').onclick=async()=>{$('test-comfy').disabled=true;$('comfy-result').textContent='Connecting…';try{$('comfy-result').textContent=await window.deck.comfyTest(comfyValue());}catch(e){$('comfy-result').textContent='Connection failed: '+e.message;}finally{$('test-comfy').disabled=false;}};
$('helper-comfy').onclick=async()=>{$('helper-comfy').disabled=true;try{$('comfy-result').textContent=await window.deck.comfyHelper();}catch(e){$('comfy-result').textContent=e.message;}finally{$('helper-comfy').disabled=false;}};
async function removeComfy(id){const config=current.comfyConnections.find(c=>c.id===id);if(config&&confirm(`Remove ${config.name} from the deck? ComfyUI itself will keep running.`)){await window.deck.comfyRemove(config.id);$('comfy-dialog').close();}}
$('remove-comfy').onclick=()=>perform(()=>removeComfy(current.selected.replace(/^comfy:/,'')));
$('delete-comfy').onclick=async()=>{try{await removeComfy(editingComfyId);}catch(e){$('comfy-result').textContent=e.message;}};
