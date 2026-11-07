import { Row, Snapshot, ModelChoice, VoiceStatus } from '../shared/types';
import { isMascotChoice, MascotChoice } from './mascot';
import { openCodeModelLabel } from './opencode';
export const MODES = ['Read-only', 'Auto', 'No prompts', 'YOLO / Full access'];
export type Page = 'agent' | 'details' | 'image' | 'settings' | 'model' | 'effort' | 'confirm' | 'global' | 'voice';
export interface Intent { method: string; params: Record<string, any> }
export function effortLabel(value:unknown):string {
  if(value===null)return 'Default';
  if(typeof value!=='string'||!value)return 'Unknown';
  return value==='xhigh'?'XHigh':value[0].toUpperCase()+value.slice(1);
}
export function modelLabel(row:Row|undefined,snapshot:Snapshot):string {
  if(row?.source==='opencode')return openCodeModelLabel(row.opencode);
  const model=row?.settings?.model;
  return snapshot.models?.find(m=>m.id===model)?.label||model||'Model unknown';
}
export function modeLabel(settings?: Record<string, any>): string {
  if (!settings) return 'Unknown';
  const sandbox = settings.sandboxPolicy?.type, policy = settings.approvalPolicy;
  if (sandbox === 'dangerFullAccess' && policy === 'never') return 'Full access';
  if (sandbox === 'workspaceWrite' && policy === 'never') return 'No prompts';
  if (sandbox === 'workspaceWrite' && policy === 'on-request') return 'Auto';
  if (sandbox === 'readOnly' && policy === 'on-request') return 'Read-only';
  return 'Custom';
}
export class Controller {
  voice:VoiceStatus={phase:'idle'};
  snapshot: Snapshot = {rows: [], connected: false, error: ''};
  selected = ''; page: Page = 'agent'; cursor = 0; scroll = 0; notice = ''; busy = false;
  confirm: ({kind:'permission';row:Row;mode:string}|{kind:'model'|'effort';row:Row;model:string;effort:string|null;label:string;catalogToken:string}) | null = null;
  displayedApproval: {id: string; session: string; token: string} | null = null;
  configurationDraft:{row:Row;model:ModelChoice;catalogToken:string}|null=null;
  preferences = {brightness: 85, lights: true, mascot:'cat' as MascotChoice, voiceDevice:'',spokenReplies:false,voiceName:''};
  private voiceDraftChoices:string[]=[];
  loadPreferences(value:unknown) {
    if(!value||typeof value!=='object')return;
    const p=value as Record<string,unknown>;
    if(typeof p.lights==='boolean')this.preferences.lights=p.lights;
    if(typeof p.brightness==='number'&&Number.isFinite(p.brightness))this.preferences.brightness=Math.max(25,Math.min(100,p.brightness));
    if(isMascotChoice(p.mascot))this.preferences.mascot=p.mascot;
    if(typeof p.voiceDevice==='string'&&p.voiceDevice.length<=1024)this.preferences.voiceDevice=p.voiceDevice==='default'?'':p.voiceDevice;
    if(typeof p.spokenReplies==='boolean')this.preferences.spokenReplies=p.spokenReplies;
    if(typeof p.voiceName==='string'&&/^[a-z0-9_-]{0,64}$/.test(p.voiceName))this.preferences.voiceName=p.voiceName;
  }
  setMascot(value:unknown) {
    if(!isMascotChoice(value))throw new Error('Unknown companion');
    this.preferences.mascot=value;
  }
  private returnPage: Page = 'agent';
  private returnCursor = 0;
  update(snapshot: Snapshot) {
    const old = this.row;
    this.snapshot = snapshot;
    // Selection survives offline OpenCode entries (their outage is shown), but a
    // connection going offline still falls back like before.
    const current = this.snapshot.rows.find(r => r.id === this.selected);
    const retained = !!current && !(current.source==='comfyui' && current.comfy?.connected!==true);
    if (!retained) {
      const selected=this.rows[0]?.id??'';
      if(this.selected!==selected){this.selected=selected;this.back();}
    }
    else if (old?.control_token !== this.row?.control_token) this.displayedApproval = null;
  }
  // Keep every connection in the desktop snapshot, but only online ComfyUI/OpenCode entries on the pad.
  get rows() {
    return this.snapshot.rows.filter(r=>{
      if(r.source==='comfyui')return r.comfy?.connected===true;
      if(r.source==='opencode')return r.opencode?.connected===true;
      return true;
    });
  }
  get row() { return this.snapshot.rows.find(r => r.id === this.selected); }
  get attention() { return this.rows.filter(r => r.state === 'waiting' || r.state === 'error'); }
  get modelChoices() { return this.snapshot.models??[]; }
  get effortChoices() { return this.configurationDraft?.model.efforts??[]; }
  get voiceChoices(){return this.snapshot.voices??[];}
  setVoiceName(name:unknown){
    if(typeof name!=='string'||(name!==''&&!this.voiceChoices.includes(name)))throw Error('Voice is unavailable. Choose an available voice or Codex default.');
    this.preferences.voiceName=name;
    this.notice='Voice saved · next session';
  }
  get canChooseModel() { return this.row?.source!=='opencode'&&!!this.row?.settings_token&&!!this.snapshot.models_token&&this.modelChoices.length>0; }
  get pickerLabels() {
    if(this.page==='voice')return [...this.voiceDraftChoices.map(v=>v?v[0].toUpperCase()+v.slice(1):'Codex default'),'Back'];
    return [...(this.page==='model'?this.modelChoices.map(m=>m.label+(m.id===this.row?.settings?.model?' · current':'')):
      this.effortChoices.map(e=>effortLabel(e)+(this.configurationDraft?.model.id===this.row?.settings?.model&&e===this.row?.settings?.effort?' · current':''))),'Back'];
  }
  openConfiguration() {
    if(this.busy)return;
    if(!this.canChooseModel){this.notice=this.snapshot.models_error||'Choices unavailable for this agent';return;}
    this.page='model';this.displayedApproval=null;this.configurationDraft=null;this.confirm=null;
    this.cursor=Math.max(0,this.modelChoices.findIndex(m=>m.id===this.row?.settings?.model));
  }
  cancelOrBack() {
    if(this.busy)return;
    if(this.page==='voice'){this.page='global';this.cursor=4;return;}
    if(this.page==='confirm'&&this.confirm?.kind==='model'&&this.configurationDraft){
      this.page='effort';this.cursor=Math.max(0,this.effortChoices.indexOf(this.confirm.effort??''));this.confirm=null;
      if(!this.effortChoices.length)this.cancelOrBack();
    }else if(this.page==='effort'&&this.configurationDraft){
      this.page='model';this.cursor=Math.max(0,this.modelChoices.findIndex(m=>m.id===this.configurationDraft?.model.id));this.configurationDraft=null;
    }else this.back();
  }
  private reviewConfiguration(effort:string|null) {
    const draft=this.configurationDraft;if(!draft)return;
    this.confirm={kind:'model',row:structuredClone(draft.row),model:draft.model.id,effort,label:draft.model.label,catalogToken:draft.catalogToken};this.page='confirm';
  }
  get menu() { return [...(this.row?.comfy?.latest?['Latest image']:[]),'Activity / request', ...(this.row?.settings ? ['Permission mode'] : []),
    ...(this.canChooseModel?['Model & Effort']:[]),
    ...(this.row?.actions.includes('reject') ? ['Reject request'] : []),
    ...(this.row?.actions.includes('stop') ? ['Stop turn'] : []),
    ...(this.row?.actions.includes('continue') ? ['Continue'] : []), 'Global settings', 'Back']; }
  get globalMenu() { return [`Screen brightness: ${this.preferences.brightness}%`, `Status lights: ${this.preferences.lights ? 'On' : 'Off'}`, `Companion: ${this.preferences.mascot==='cat'?'Cat':this.preferences.mascot==='owl'?'Owl':'Off'}`, `Spoken replies: ${this.preferences.spokenReplies?'On':'Off'}`, `Voice: ${this.preferences.voiceName||'Codex default'}`, 'Close settings']; }
  back() { this.page = 'agent'; this.cursor = 0; this.scroll = 0; this.confirm = null; this.configurationDraft=null;this.displayedApproval = null; }
  select(id: string) {
    if (this.busy) return;
    const row=this.snapshot.rows.find(r=>r.id===id);
    if(!row)return;
    // Offline ComfyUI connections stay editor-only; offline OpenCode entries can be inspected.
    if(row.source==='comfyui'&&row.comfy?.connected!==true)return;
    this.selected = id; this.back();
  }
  action(verb: string, row = this.row): Intent | undefined {
    if (!row || !row.actions.includes(verb)) return;
    if(row.source==='comfyui')return verb==='focus'?{method:'comfy-focus',params:{id:row.id}}:undefined;
    if(row.source==='opencode')return {method:'opencode-action',params:{id:row.id,session_id:row.session_id,verb,token:row.control_token}};
    return {method: 'action', params: {id: row.id, session_id: row.session_id, verb, token: row.control_token}};
  }
  markDisplayed(id: string, session: string, token: string) {
    const r = this.row;
    if (r?.id === id && r.session_id === session && r.control_token === token && (this.page === 'agent' || this.page === 'details')) this.displayedApproval = {id, session, token};
  }
  get canApprove() {
    const r = this.row, d = this.displayedApproval;
    return !!r && r.source!=='comfyui' && !!d && r.actions.includes('approve') && r.id === d.id && r.session_id === d.session && r.control_token === d.token;
  }
  key(key: number): Intent | undefined {
    if(key===2)return {method:'voice-toggle',params:{}};
    if (this.busy) return;
    this.notice = '';
    if (key === 0) {
      if (this.page !== 'agent' && this.page !== 'details') return;
      if (!this.canApprove) { this.notice = this.row?.actions.includes('approve') ? 'Request updating — wait for display' : 'No approval pending'; return; }
      const intent = this.action('approve'); this.displayedApproval = null; return intent;
    }
    if (key === 1) return this.action('focus');
  }
  nextAttention() {
    if(this.busy)return;
      const rows = this.rows, start = rows.findIndex(r => r.id === this.selected);
      for (let step = 1; step <= rows.length; step++) {
        const r = rows[(start + step) % rows.length];
        if (r.state === 'waiting' || r.state === 'error') { this.select(r.id); return; }
      }
      this.notice = 'No agents need attention';
  }
  rotate(direction: number) {
    if (this.busy || !direction) return;
    this.notice = '';
    const delta = direction > 0 ? 1 : -1;
    if (this.page === 'agent'||this.page==='image') {
      const rows = this.rows; if (!rows.length) return;
      const index = rows.findIndex(r => r.id === this.selected);
      this.select(rows[(index + delta + rows.length) % rows.length].id);
    } else if (this.page === 'details') this.cursor = (this.cursor + delta + this.menu.length) % this.menu.length;
    else if (this.page === 'settings') this.cursor = (this.cursor + delta + MODES.length + 1) % (MODES.length + 1);
    else if (this.page === 'model'||this.page==='effort'||this.page==='voice') this.cursor=(this.cursor+delta+this.pickerLabels.length)%this.pickerLabels.length;
    else if (this.page === 'global') this.cursor = (this.cursor + delta + this.globalMenu.length) % this.globalMenu.length;
  }
  press(): Intent | undefined {
    if (this.busy) return;
    this.notice = '';
    if(this.page==='voice'){
      if(this.cursor===this.voiceDraftChoices.length){this.page='global';this.cursor=4;return;}
      try{this.setVoiceName(this.voiceDraftChoices[this.cursor]);this.page='global';this.cursor=4;}
      catch(e){this.notice=String((e as Error).message);}
      return;
    }
    if (this.page === 'agent') { this.page = 'details'; this.cursor = 0; this.scroll = 0; }
    else if (this.page === 'details') {
      const entry = this.menu[this.cursor];
      if(entry==='Latest image'){this.page='image';this.displayedApproval=null;}
      else if (entry === 'Activity / request') { this.scroll += 3; }
      else if (entry === 'Global settings') this.toggleGlobal();
      else if (entry === 'Permission mode') { this.page = 'settings'; this.cursor = Math.max(0,MODES.indexOf(this.row?.source==='opencode'?String(this.row?.settings?.mode??''):modeLabel(this.row?.settings))); }
      else if(entry==='Model & Effort')this.openConfiguration();
      else if (entry === 'Stop turn' || entry === 'Continue' || entry === 'Reject request') { this.back(); return this.action(entry === 'Stop turn' ? 'stop' : entry === 'Continue' ? 'continue' : 'reject'); }
      else if (entry === 'Back') this.back();
    } else if(this.page==='image'){this.page='details';this.cursor=0;}
    else if (this.page === 'settings') {
      if (this.cursor === MODES.length) this.back();
      else if (this.row) { this.confirm = {kind:'permission',row: structuredClone(this.row), mode: MODES[this.cursor]}; this.page = 'confirm'; }
    } else if(this.page==='model'||this.page==='effort'){
      if(this.cursor===this.pickerLabels.length-1){this.cancelOrBack();return;}
      if(this.page==='model'){
        const target=this.modelChoices[this.cursor];
        if(!this.row||!target||!this.snapshot.models_token){this.back();this.notice='Choices changed. Reopen the selector.';return;}
        this.configurationDraft={row:structuredClone(this.row),model:structuredClone(target),catalogToken:this.snapshot.models_token};
        if(!target.efforts.length){this.reviewConfiguration(null);return;}
        const current=this.row.settings?.effort,initial=target.efforts.includes(current)?current:target.defaultEffort;
        this.page='effort';this.cursor=Math.max(0,target.efforts.indexOf(initial??''));
      }else{
        const effort=this.effortChoices[this.cursor];
        if(effort===undefined){this.back();this.notice='Effort choices changed. Reopen the selector.';return;}
        this.reviewConfiguration(effort);
      }
    } else if (this.page === 'confirm') {
      const confirmation = this.confirm; this.back();
      if(confirmation?.kind==='permission'){
        if(confirmation.row.source==='opencode')return {method:'opencode-settings', params:{id:confirmation.row.id, session_id:confirmation.row.session_id, mode:confirmation.mode, token:confirmation.row.settings_token}};
        return {method:'settings', params:{id:confirmation.row.id, session_id:confirmation.row.session_id, mode:confirmation.mode, token:confirmation.row.settings_token}};
      }
      if(confirmation)return {method:'configuration',params:{id:confirmation.row.id,session_id:confirmation.row.session_id,kind:confirmation.kind,model:confirmation.model,effort:confirmation.effort,token:confirmation.row.settings_token,catalog_token:confirmation.catalogToken}};
    } else if (this.page === 'global') {
      if (this.cursor === 0) this.preferences.brightness = this.preferences.brightness >= 100 ? 25 : Math.min(100,this.preferences.brightness+15);
      if (this.cursor === 1) this.preferences.lights = !this.preferences.lights;
      if (this.cursor === 2) this.setMascot(this.preferences.mascot==='cat'?'owl':this.preferences.mascot==='owl'?'off':'cat');
      if (this.cursor === 3) this.preferences.spokenReplies=!this.preferences.spokenReplies;
      if (this.cursor === 4) {
        this.voiceDraftChoices=['',...this.voiceChoices];this.page='voice';
        this.cursor=Math.max(0,this.voiceDraftChoices.indexOf(this.preferences.voiceName));
      }else if(this.cursor===5)this.toggleGlobal();
    }
  }
  toggleGlobal() {
    if (this.busy) return;
    this.displayedApproval = null;
    if (this.page === 'global'||this.page==='voice') { this.page = this.returnPage; this.cursor = this.returnCursor; }
    else { this.returnPage = this.page; this.returnCursor = this.cursor; this.page = 'global'; this.cursor = 0; }
  }
}
