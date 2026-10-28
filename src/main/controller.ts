import { Row, Snapshot } from '../shared/types';
import { isMascotChoice, MascotChoice } from './mascot';
export const MODES = ['Read-only', 'Auto', 'No prompts', 'YOLO / Full access'];
export type Page = 'agent' | 'details' | 'settings' | 'confirm' | 'global';
export interface Intent { method: string; params: Record<string, any> }
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
  snapshot: Snapshot = {rows: [], connected: false, error: ''};
  selected = ''; page: Page = 'agent'; cursor = 0; scroll = 0; notice = ''; busy = false;
  confirm: {row: Row; mode: string} | null = null;
  displayedApproval: {id: string; session: string; token: string} | null = null;
  preferences = {brightness: 85, lights: true, mascot:'cat' as MascotChoice};
  loadPreferences(value:unknown) {
    if(!value||typeof value!=='object')return;
    const p=value as Record<string,unknown>;
    if(typeof p.lights==='boolean')this.preferences.lights=p.lights;
    if(typeof p.brightness==='number'&&Number.isFinite(p.brightness))this.preferences.brightness=Math.max(25,Math.min(100,p.brightness));
    if(isMascotChoice(p.mascot))this.preferences.mascot=p.mascot;
  }
  setMascot(value:unknown) {
    if(!isMascotChoice(value))throw new Error('Unknown mascot');
    this.preferences.mascot=value;
  }
  private returnPage: Page = 'agent';
  private returnCursor = 0;
  update(snapshot: Snapshot) {
    const old = this.row;
    this.snapshot = snapshot;
    if (!snapshot.rows.some(r => r.id === this.selected)) { this.selected = snapshot.rows[0]?.id ?? ''; this.back(); }
    else if (old?.control_token !== this.row?.control_token) this.displayedApproval = null;
  }
  get row() { return this.snapshot.rows.find(r => r.id === this.selected); }
  get attention() { return this.snapshot.rows.filter(r => r.state === 'waiting' || r.state === 'error'); }
  get menu() { return ['Activity / request', ...(this.row?.settings ? ['Permission mode'] : []),
    ...(this.row?.actions.includes('reject') ? ['Reject request'] : []),
    ...(this.row?.actions.includes('stop') ? ['Stop turn'] : []),
    ...(this.row?.actions.includes('continue') ? ['Continue'] : []), 'Global settings', 'Back']; }
  get globalMenu() { return [`Screen brightness: ${this.preferences.brightness}%`, `Status lights: ${this.preferences.lights ? 'On' : 'Off'}`, `Mascot: ${this.preferences.mascot==='cat'?'Cat':this.preferences.mascot==='owl'?'Owl':'Off'}`, 'Close settings']; }
  back() { this.page = 'agent'; this.cursor = 0; this.scroll = 0; this.confirm = null; this.displayedApproval = null; }
  select(id: string) { if (this.busy) return; if (this.snapshot.rows.some(r => r.id === id)) { this.selected = id; this.back(); } }
  action(verb: string, row = this.row): Intent | undefined {
    if (!row || !row.actions.includes(verb)) return;
    return {method: 'action', params: {id: row.id, session_id: row.session_id, verb, token: row.control_token}};
  }
  markDisplayed(id: string, session: string, token: string) {
    const r = this.row;
    if (r?.id === id && r.session_id === session && r.control_token === token && (this.page === 'agent' || this.page === 'details')) this.displayedApproval = {id, session, token};
  }
  get canApprove() {
    const r = this.row, d = this.displayedApproval;
    return !!r && !!d && r.actions.includes('approve') && r.id === d.id && r.session_id === d.session && r.control_token === d.token;
  }
  key(key: number): Intent | undefined {
    if (this.busy) return;
    this.notice = '';
    if (key === 0) {
      if (this.page !== 'agent' && this.page !== 'details') return;
      if (!this.canApprove) { this.notice = this.row?.actions.includes('approve') ? 'Request updating — wait for display' : 'No approval pending'; return; }
      const intent = this.action('approve'); this.displayedApproval = null; return intent;
    }
    if (key === 1) return this.action('focus');
    if (key === 2) {
      const rows = this.snapshot.rows, start = rows.findIndex(r => r.id === this.selected);
      for (let step = 1; step <= rows.length; step++) {
        const r = rows[(start + step) % rows.length];
        if (r.state === 'waiting' || r.state === 'error') { this.select(r.id); return; }
      }
      this.notice = 'No agents need attention';
    }
  }
  rotate(direction: number) {
    if (this.busy || !direction) return;
    this.notice = '';
    const delta = direction > 0 ? 1 : -1;
    if (this.page === 'agent') {
      const rows = this.snapshot.rows; if (!rows.length) return;
      const index = rows.findIndex(r => r.id === this.selected);
      this.select(rows[(index + delta + rows.length) % rows.length].id);
    } else if (this.page === 'details') this.cursor = (this.cursor + delta + this.menu.length) % this.menu.length;
    else if (this.page === 'settings') this.cursor = (this.cursor + delta + MODES.length + 1) % (MODES.length + 1);
    else if (this.page === 'global') this.cursor = (this.cursor + delta + this.globalMenu.length) % this.globalMenu.length;
  }
  press(): Intent | undefined {
    if (this.busy) return;
    this.notice = '';
    if (this.page === 'agent') { this.page = 'details'; this.cursor = 0; this.scroll = 0; }
    else if (this.page === 'details') {
      const entry = this.menu[this.cursor];
      if (entry === 'Activity / request') { this.scroll += 3; }
      else if (entry === 'Global settings') this.toggleGlobal();
      else if (entry === 'Permission mode') { this.page = 'settings'; this.cursor = Math.max(0,MODES.indexOf(modeLabel(this.row?.settings))); }
      else if (entry === 'Stop turn' || entry === 'Continue' || entry === 'Reject request') { this.back(); return this.action(entry === 'Stop turn' ? 'stop' : entry === 'Continue' ? 'continue' : 'reject'); }
      else if (entry === 'Back') this.back();
    } else if (this.page === 'settings') {
      if (this.cursor === MODES.length) this.back();
      else if (this.row) { this.confirm = {row: structuredClone(this.row), mode: MODES[this.cursor]}; this.page = 'confirm'; }
    } else if (this.page === 'confirm') {
      const confirmation = this.confirm; this.back();
      if (confirmation) return {method:'settings', params:{id:confirmation.row.id, session_id:confirmation.row.session_id, mode:confirmation.mode, token:confirmation.row.settings_token}};
    } else if (this.page === 'global') {
      if (this.cursor === 0) this.preferences.brightness = this.preferences.brightness >= 100 ? 25 : Math.min(100,this.preferences.brightness+15);
      if (this.cursor === 1) this.preferences.lights = !this.preferences.lights;
      if (this.cursor === 2) this.setMascot(this.preferences.mascot==='cat'?'owl':this.preferences.mascot==='owl'?'off':'cat');
      if (this.cursor === 3) this.toggleGlobal();
    }
  }
  toggleGlobal() {
    if (this.busy) return;
    this.displayedApproval = null;
    if (this.page === 'global') { this.page = this.returnPage; this.cursor = this.returnCursor; }
    else { this.returnPage = this.page; this.returnCursor = this.cursor; this.page = 'global'; this.cursor = 0; }
  }
}
