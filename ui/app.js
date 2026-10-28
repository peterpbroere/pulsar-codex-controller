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
 $('setup-help').hidden=v.demo||v.snapshot.rows.length>0;
 $('setup-help').textContent=diagnostics&&!diagnostics.codex_installed?'Install Codex CLI, sign in with codex login, then restart this app.':diagnostics?.hooks_configured?'Hooks found. In Codex, run /hooks to review/trust them, then start or resume a session and send a prompt.':'Connect Codex to install the session-status hooks. Existing hooks are backed up and preserved.';
 animate(v);$('mascot-choice').value=v.preferences.mascot;$('mascot-choice').disabled=v.busy;
 const list=$('sessions');list.replaceChildren();
 for(const r of v.snapshot.rows){const b=document.createElement('button');b.className='session'+(r.id===v.selected?' selected':'');b.disabled=v.busy;const name=document.createElement('strong');name.textContent=r.label;const state=document.createElement('span');state.textContent=r.state.toUpperCase()+' · '+r.reason;state.className=r.state;b.append(name,state);b.onclick=()=>perform(()=>window.deck.select(r.id));list.append(b);}
 if(!v.snapshot.rows.length){const p=document.createElement('p');p.className='empty';p.textContent='Your participating Codex sessions appear here after their first prompt. Use Connect Codex to set up session discovery.';list.append(p);}
 const r=v.snapshot.rows.find(r=>r.id===v.selected);
 $('name').textContent=r?.label||'No sessions yet';$('project').textContent=r?.project||'';$('reason').textContent=r?.reason||'';
 $('model-effort').textContent=r?`Model: ${v.modelLabel} · Effort: ${v.effortLabel}`:'';
 const actions=$('actions');actions.replaceChildren();
 for(const [verb,label] of [['focus','Open on PC'],['stop','Stop turn'],['continue','Continue']]) if(r?.actions.includes(verb)) actions.append(button(label,verb,!v.busy));
 if(r?.review)actions.append(button('Review request','review',!v.busy));
 if(r?.settings)actions.append(button('Permission mode','settings',!v.busy));
 if(v.canChooseModel)actions.append(button('Model & Effort','model',!v.busy));
 const settings=r?.settings;$('settings').textContent=settings?`Approval: ${typeof settings.approvalPolicy==='string'?settings.approvalPolicy:JSON.stringify(settings.approvalPolicy)} · Sandbox: ${settings.sandboxPolicy?.type}\nChanges apply to subsequent turns.`:r?.settings_error||r?.control_hint||'';
 $('review-panel').hidden=v.page!=='details'||!v.review?.review;$('review').textContent=v.review?.review||'';
 $('approve').disabled=v.busy||!v.canApprove;$('reject').disabled=v.busy||!v.review?.actions.includes('reject');
 document.querySelectorAll('[data-key]').forEach(b=>{const key=Number(b.dataset.key);b.disabled=v.busy||(key===0&&!v.canApprove)||(key===1&&!r?.actions.includes('focus'))||(key===2&&!v.snapshot.rows.some(r=>r.state==='waiting'||r.state==='error'));});
 $('status').textContent=v.notice||v.device.error||v.snapshot.error||(v.busy?'Working…':v.snapshot.connected?'Ready · '+v.inputMode:'Waiting for participating Codex sessions');
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
