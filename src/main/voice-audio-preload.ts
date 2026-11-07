import { contextBridge, ipcRenderer } from 'electron';

const channel = 'pulsar-voice-audio';
type Command = { token: string; [key: string]: any };
contextBridge.exposeInMainWorld('voiceHost', {
  listen(handler: (name: string, payload: Command) => void) {
    for (const name of ['start', 'answer', 'stop', 'devices', 'playback']) {
      ipcRenderer.on(`${channel}:${name}`, (_event, payload) => handler(name, payload));
    }
  },
  reply(token: string, value?: unknown, error?: string) { ipcRenderer.send(`${channel}:reply`, token, { value, error }); },
  state(id: string, state: 'connecting' | 'active') { ipcRenderer.send(`${channel}:state`, id, state); },
  error(id: string, message: string) { ipcRenderer.send(`${channel}:error`, id, message); },
  ended(id: string) { ipcRenderer.send(`${channel}:ended`, id); },
  devicesChanged() {ipcRenderer.send(`${channel}:devices-changed`);},
});
