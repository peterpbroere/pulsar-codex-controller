import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('deck', {
  view:()=>ipcRenderer.invoke('view'),
  key:(key:number)=>ipcRenderer.invoke('key',key),
  select:(id:string)=>ipcRenderer.invoke('select',id),
  action:(verb:string)=>ipcRenderer.invoke('action',verb),
  back:()=>ipcRenderer.invoke('back'),
  control:(name:string)=>ipcRenderer.invoke('control',name),
  setup:()=>ipcRenderer.invoke('setup'),
  onView:(callback:(view:unknown)=>void)=>ipcRenderer.on('view',(_e,value)=>callback(value)),
});
