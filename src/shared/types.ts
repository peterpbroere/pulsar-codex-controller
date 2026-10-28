export interface HidTarget { mod: number; key: number }
export interface Row {
  id: string; session_id: string; label: string; state: string;
  reason: string; detail: string; project: string;
  actions: string[]; control_token: string; review: string; control_hint: string;
  settings?: Record<string, any>; settings_token?: string;
}
export interface Snapshot {
  rows: Row[]; connected: boolean; error: string; setup_message?: string;
  diagnostics?: {codex_installed: boolean; hooks_configured: boolean; pulsar_hooks: boolean};
}
