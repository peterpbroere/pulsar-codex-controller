export interface HidTarget { mod: number; key: number }
export interface ModelChoice { id:string; label:string; efforts:string[]; defaultEffort:string|null }
export interface ComfyConnection { id:string; name:string; url:string }
export interface ComfyImage { image:string; filename:string; promptId:string }
export interface ComfyStatus {
  connected:boolean; url:string; running:number; pending:number; promptId:string;
  node:string; progress?:{value:number;max:number}; total?:{value:number;max:number}; helper:boolean;
  latest?:ComfyImage; imageError?:string;
}
export interface Row {
  id: string; session_id: string; label: string; title?:string; state: string;
  reason: string; detail: string; project: string;
  actions: string[]; control_token: string; review: string; control_hint: string;
  settings?: Record<string, any>; settings_token?: string;
  source?:'comfyui'; comfy?:ComfyStatus;
}
export interface Snapshot {
  voices?:string[]; voices_error?:string;
  rows: Row[]; connected: boolean; error: string; setup_message?: string;
  diagnostics?: {codex_installed: boolean; hooks_configured: boolean; pulsar_hooks: boolean};
  models?: ModelChoice[]; models_token?: string|null; models_error?: string;
}
export interface VoiceStatus {
  phase:'idle'|'starting'|'active'|'stopping'|'error';
  voiceId?:string;
  target?:{id:string;sessionId:string;label:string};
  error?:string;
  transcript?:string;
  reply?:string;
  speakingUntil?:number;
}
