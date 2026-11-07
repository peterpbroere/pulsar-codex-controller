import { BrowserWindow, ipcMain, session, Session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export type VoiceState = 'connecting' | 'active';
export interface VoiceAudioCallbacks {
  state: (voiceId: string, state: VoiceState) => void;
  error: (voiceId: string, message: string) => void;
  devicesChanged?:()=>void;
}
export interface VoiceDevice { id: string; label: string }
type IpcEvent = { sender: { id: number; getURL(): string } };
type WindowLike = {
  webContents: { id: number; getURL(): string; send(channel: string, ...args: unknown[]): void; on(event: string, listener: (...args: any[]) => void): void };
  isDestroyed(): boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  loadFile(file: string): Promise<void>;
  destroy(): void;
};
type VoiceDeps = {
  createWindow(options: any): WindowLike;
  getSession(partition: string): Session;
  ipc: typeof ipcMain;
  preload: string;
};
const CHANNEL = 'pulsar-voice-audio';
const SDP_LIMIT = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
export function validVoiceSdp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SDP_LIMIT &&
    value.startsWith('v=0\r\n') && value.includes('\nm=audio ') && /a=ice-ufrag:/i.test(value);
}

/** A hidden, isolated renderer that captures microphone audio for the native voice service. */
export class VoiceAudio {
  private win?: WindowLike;
  private ready?: Promise<void>;
  private voiceId?: string;
  private allowedVoiceId?: string;
  private closed = false;
  private partition = 'persist:pulsar-voice';
  private trustedUrl: string;
  private senderId?: number;
  private operation = 0;
  private playbackEnabled = false;
  private startDispatchedVoiceId?: string;
  private wired = false;
  private deps: VoiceDeps;
  constructor(private root: string, private callbacks: VoiceAudioCallbacks, deps?: VoiceDeps) {
    this.root = resolve(root);
    this.trustedUrl = pathToFileURL(join(this.root, 'ui', 'voice.html')).href;
    this.deps = deps ?? { createWindow: options => new BrowserWindow(options) as unknown as WindowLike,
      getSession: partition => session.fromPartition(partition), ipc: ipcMain, preload: join(__dirname, 'voice-audio-preload.js') };
  }

  async start(voiceId: string, deviceId?: string): Promise<string> {
    this.checkId(voiceId);
    if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.length > 512)) throw Error('Invalid microphone device.');
    if (this.closed) throw Error('Microphone audio host is closed.');
    if (this.voiceId) await this.stop(this.voiceId);
    const operation = ++this.operation;
    this.voiceId = voiceId;
    this.allowedVoiceId = undefined;
    this.callbacks.state(voiceId, 'connecting');
    let win: WindowLike | undefined;
    try {
      win = await this.waitForOperation(operation, this.ensureWindow());
      if (this.operation !== operation || this.voiceId !== voiceId || this.closed) throw Error('Microphone start was cancelled.');
      this.allowedVoiceId = voiceId;
      this.startDispatchedVoiceId = voiceId;
      const result = await this.invoke<string>(win, 'start', { voiceId, deviceId, playback: this.playbackEnabled });
      if (this.operation !== operation || this.voiceId !== voiceId || this.closed) throw Error('Microphone start was cancelled.');
      if (!validVoiceSdp(result)) throw Error('Microphone capture returned an invalid WebRTC offer.');
      return result;
    } catch (error) {
      if (this.operation === operation && this.voiceId === voiceId) {
        await this.stop(voiceId);
        this.callbacks.error(voiceId, this.message(error));
      }
      throw error;
    }
  }

  async setPlayback(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw Error('Playback setting must be enabled or disabled.');
    this.playbackEnabled = enabled;
    const voiceId = this.voiceId;
    if (!voiceId || !this.win || this.win.isDestroyed()) return;
    const win = this.win;
    await this.ready;
    if (this.voiceId !== voiceId || this.startDispatchedVoiceId !== voiceId || this.win !== win || win.isDestroyed()) return;
    await this.invoke<void>(win, 'playback', { voiceId, enabled });
  }

  async answer(voiceId: string, sdp: string): Promise<void> {
    this.checkId(voiceId);
    if (voiceId !== this.voiceId || !this.win || this.win.isDestroyed()) throw Error('No matching microphone session is active.');
    if (!validVoiceSdp(sdp)) throw Error('Invalid WebRTC answer.');
    try { await this.invoke<void>(this.win, 'answer', { voiceId, sdp }); }
    catch (error) {
      if (this.voiceId === voiceId) {
        await this.stop(voiceId);
        this.callbacks.error(voiceId, this.message(error));
      }
      throw error;
    }
  }

  async stop(voiceId?: string): Promise<void> {
    if (voiceId !== undefined) this.checkId(voiceId);
    if (voiceId && voiceId !== this.voiceId) return;
    ++this.operation;
    if (!this.voiceId) return;
    const current = this.voiceId;
    this.voiceId = undefined;
    this.startDispatchedVoiceId = undefined;
    this.allowedVoiceId = undefined;
    for (const cancel of this.cancelOperations.values()) cancel();
    this.cancelOperations.clear();
    const win = this.win;
    if (win && !win.isDestroyed()) {
      await Promise.race([
        this.invoke<void>(win, 'stop', { voiceId: current }).catch(() => {}),
        new Promise<void>(resolve => setTimeout(resolve, 100)),
      ]);
      this.destroyWindow(win, Error('Microphone session stopped.'));
    }
    if(!this.closed)this.callbacks.devicesChanged?.();
  }

  async devices(): Promise<VoiceDevice[]> {
    if (this.closed) return [];
    const win = await this.ensureWindow();
    const result = await this.invoke<unknown>(win, 'devices', {});
    if (!Array.isArray(result)) return [];
    return result.slice(0, 64).flatMap((d: any) => typeof d?.deviceId === 'string' && d.deviceId.length <= 512 && d.deviceId
      ? [{ id: d.deviceId, label: typeof d.label === 'string' ? d.label.slice(0, 160) : '' }] : []);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    const win = this.win;
    this.win = undefined;
    this.ready = undefined;
    if (this.wired) {
      if (this.replyListener) this.deps.ipc.removeListener(`${CHANNEL}:reply`, this.replyListener);
      for (const name of ['state', 'error', 'ended', 'devices-changed']) this.deps.ipc.removeAllListeners(`${CHANNEL}:${name}`);
      this.wired = false;
    }
    for (const pending of this.pending.values()) pending.reject(Error('Microphone audio host closed.'));
    this.pending.clear();
    if (win && !win.isDestroyed()) win.destroy();
  }

  private checkId(id: string) { if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw Error('Invalid voice session ID.'); }
  private message(error: unknown) { const s = error instanceof Error ? error.message : String(error); return s.slice(0, 300) || 'Microphone audio failed.'; }
  private async ensureWindow(): Promise<WindowLike> {
    if (this.win && !this.win.isDestroyed()) { await this.ready; return this.win; }
    if (this.closed) throw Error('Microphone audio host is closed.');
    const ses = this.deps.getSession(this.partition);
    ses.setPermissionRequestHandler((wc, permission, callback, details: any) => {
      const permitted = permission === 'media' && this.allowedVoiceId !== undefined && wc.id === this.senderId &&
        this.isTrustedUrl(wc.getURL()) && Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
      callback(permitted);
    });
    ses.setPermissionCheckHandler((wc, permission, _origin, details: any) => permission === 'media' &&
      (details?.mediaType === 'audio' || (Array.isArray(details?.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio')) &&
      !this.closed && !!this.win && !this.win.isDestroyed() && !!wc && wc.id === this.senderId && this.isTrustedUrl(wc.getURL()) && details?.isMainFrame!==false);
    this.win = this.deps.createWindow({ width: 1, height: 1, show: false, skipTaskbar: true,
      webPreferences: { partition: this.partition, preload: this.deps.preload, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const win = this.win;
    this.senderId = win.webContents.id;
    this.installIpc();
    win.on('closed', () => { if (this.win === win) { this.destroyWindow(win, Error('Microphone audio window closed.')); this.failCurrent('Microphone audio window was closed.'); } });
    win.webContents.on('render-process-gone', () => { if (this.win === win) { this.destroyWindow(win, Error('Microphone audio renderer stopped.')); this.failCurrent('Microphone audio renderer stopped unexpectedly.'); } });
    win.webContents.on('will-navigate', (event: any, url: string) => { if (!this.isTrustedUrl(url)) event.preventDefault(); });
    this.ready = win.loadFile(join(this.root, 'ui', 'voice.html')).then(() => undefined);
    await this.ready;
    return win;
  }

  private installIpc() {
    if (this.wired) return;
    this.wired = true;
    this.replyListener = (event: IpcEvent, token: string, payload: any) => {
      if (!this.validSender(event) || typeof token !== 'string' || !ID_PATTERN.test(token)) throw Error('Untrusted microphone renderer.');
      const pending = this.pending.get(token); if (!pending) return;
      if (payload?.error) pending.reject(Error(this.message(payload.error)));
      else pending.resolve(payload?.value);
      this.pending.delete(token);
    };
    this.deps.ipc.on(`${CHANNEL}:reply`, this.replyListener);
    this.deps.ipc.on(`${CHANNEL}:devices-changed`,(event:IpcEvent)=>{
      if(this.validSender(event))this.callbacks.devicesChanged?.();
    });
    this.deps.ipc.on(`${CHANNEL}:state`, (event: IpcEvent, id: unknown, state: unknown) => {
      if (this.validSender(event) && typeof id === 'string' && id === this.voiceId && (state === 'active' || state === 'connecting')) this.callbacks.state(id, state);
    });
    this.deps.ipc.on(`${CHANNEL}:error`, (event: IpcEvent, id: unknown, message: unknown) => {
      if (this.validSender(event) && typeof id === 'string' && id === this.voiceId) {
        void this.stop(id).then(()=>this.callbacks.error(id,this.message(message)));
      }
    });
    this.deps.ipc.on(`${CHANNEL}:ended`, (event: IpcEvent, id: unknown) => {
      if (this.validSender(event) && typeof id === 'string' && id === this.voiceId) { this.voiceId = undefined; this.allowedVoiceId = undefined; }
    });
  }
  private pending = new Map<string, { windowId: number; resolve(value: any): void; reject(error: Error): void }>();
  private cancelOperations = new Map<number, () => void>();
  private replyListener?: (event: IpcEvent, token: string, payload: any) => void;
  private isTrustedUrl(value: string) {
    try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href === this.trustedUrl; } catch { return false; }
  }
  private validSender(event: IpcEvent) { return !!this.win && !this.win.isDestroyed() && event.sender.id === this.senderId && this.isTrustedUrl(event.sender.getURL()); }
  private invoke<T>(win: WindowLike, command: string, payload: unknown): Promise<T> {
    const token = randomUUID();
    const timeout = setTimeout(() => { const p = this.pending.get(token); if (p) { this.pending.delete(token); p.reject(Error('Microphone operation timed out.')); } }, command === 'start' ? 120000 : 15000);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(token, { windowId: win.webContents.id, resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.send(win, command, { ...payload as object, token });
    });
  }
  private waitForOperation<T>(operation: number, promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(Error('Microphone start was cancelled.'));
      this.cancelOperations.set(operation, cancel);
      promise.then(resolve, reject).finally(() => { if (this.cancelOperations.get(operation) === cancel) this.cancelOperations.delete(operation); });
    });
  }
  private destroyWindow(win: WindowLike, reason: Error) {
    for (const [token, pending] of this.pending) {
      if (pending.windowId === win.webContents.id) { this.pending.delete(token); pending.reject(reason); }
    }
    if (this.win === win) { this.win = undefined; this.ready = undefined; this.senderId = undefined; }
    if (!win.isDestroyed()) win.destroy();
  }
  private send(win: WindowLike, command: string, payload: unknown) { if (!win.isDestroyed()) win.webContents.send(`${CHANNEL}:${command}`, payload); }
  private failCurrent(message: string) {
    const id = this.voiceId; this.voiceId = undefined; this.allowedVoiceId = undefined;
    if (id) this.callbacks.error(id, message);
    if(!this.closed)this.callbacks.devicesChanged?.();
  }
}
