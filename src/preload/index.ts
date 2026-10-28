import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('deck', {
  view:()=>ipcRenderer.invoke('view'),
  key:(key:number)=>ipcRenderer.invoke('key',key),
  select:(id:string)=>ipcRenderer.invoke('select',id),
  action:(verb:string)=>ipcRenderer.invoke('action',verb),
  back:()=>ipcRenderer.invoke('back'),
  control:(name:string)=>ipcRenderer.invoke('control',name),
  setup:()=>ipcRenderer.invoke('setup'),
  mascot:(choice:string)=>ipcRenderer.invoke('mascot',choice),
  onAnimation:(callback:(frame:unknown)=>void)=>ipcRenderer.on('animation',(_e,value)=>callback(value)),
  onView:(callback:(view:unknown)=>void)=>ipcRenderer.on('view',(_e,value)=>callback(value)),
});
