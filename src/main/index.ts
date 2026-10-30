import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { Backend } from './backend';
import { Controller, Intent, modelLabel, effortLabel } from './controller';
import { displaySvg, rgb565 } from './display';
import { XpadDevice } from './device/hid';
import { XpadProtocol } from './device/protocol';
import { AUXILIARY_BUTTONS, ButtonEdges } from './device/button-input';
import { DirectInput } from './device/direct-input';
import { MascotPlayer } from './mascot';
import { ComfyMonitor, connection } from './comfyui';
import { Snapshot } from '../shared/types';

const profileDirectory=process.env.PULSAR_STATE_DIR || (app.isPackaged ? join(app.getPath('appData'),'PulsarCodexDeck') : resolve(__dirname,'../../work/electron-profile'));
mkdirSync(profileDirectory,{recursive:true});
app.setPath('userData',profileDirectory);
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();
else void run();

async function run() {
  await app.whenReady();
  const root = app.getAppPath(), c = new Controller();
  const agentDeck = process.env.PULSAR_AGENT_DECK;
  const python = process.env.PULSAR_PYTHON || join(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
  const packagedBackend=app.isPackaged?join(process.resourcesPath,'backend/PulsarBackend.exe'):undefined;
  const demo = process.argv.includes('--demo');
  const noDevice = process.argv.includes('--no-device');
  const backend = demo ? null : new Backend(root, agentDeck, python, packagedBackend);
  const device = new XpadDevice(), protocol = new XpadProtocol(device);
  const auxiliaryButtons=new ButtonEdges(AUXILIARY_BUTTONS);
  const directInput=new DirectInput();
  let readingButtons=false,lastButtonError=0,buttonReads=0;
  let quitting = false, drawing = false, polling = false, remapping = false, keysReady = false;
  let win!: BrowserWindow, tray: Tray | null = null;
  let lastSvg = '', cachedFrame: Buffer | null = null, deviceError = '';
  const frameCache=new Map<string,Buffer>();
  let lastPaint: Buffer | null = null;
  const stateDir=process.env.PULSAR_STATE_DIR||(app.isPackaged?app.getPath('userData'):join(root,'work')); mkdirSync(stateDir,{recursive:true});
  const preferenceFile=join(stateDir,'preferences.json'),quitFile=join(stateDir,'quit-request');
  if(existsSync(quitFile))unlinkSync(quitFile);
  try{c.loadPreferences(JSON.parse(readFileSync(preferenceFile,'utf8')));}catch{}
  const comfyFile=join(stateDir,'comfyui.json');
  let codexSnapshot:Snapshot=c.snapshot;
  function syncSnapshot(){c.update({...codexSnapshot,rows:[...codexSnapshot.rows,...comfy.rows()]});}
  const comfy=new ComfyMonitor(()=>{syncSnapshot();publish();});
  try{
    if(existsSync(comfyFile)){
      const configs=JSON.parse(readFileSync(comfyFile,'utf8'));
      if(!Array.isArray(configs)||configs.length>8)throw Error('Invalid ComfyUI connection file');
      const parsed=configs.map(connection);
      if(new Set(parsed.map(x=>x.id)).size!==parsed.length)throw Error('Duplicate ComfyUI connection IDs');
      if(!demo)comfy.configure(parsed);
    }
  }catch(e){c.notice='Could not load ComfyUI connections: '+String((e as Error).message);}
  let mascots:MascotPlayer|null=null;
  try{mascots=await MascotPlayer.load(root);}catch(e){console.error('[mascot]',e);c.notice='Mascot artwork unavailable. Reinstall the app to restore it.';}
  if (demo) c.update({connected: false, error:'Demo — no real agent controls',
    models:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'low'},{id:'gpt-6-luna',label:'GPT-6-Luna',efforts:['low','medium','high','xhigh','max'],defaultEffort:'medium'}],models_token:'demo-catalog',rows: [
    {id:'demo1', session_id:'demo1', label:'API service', state:'waiting', reason:'Approval needed', detail:'Run unit tests?', project:'C:\\dev\\example', actions:[], control_token:'-', review:'Command:\nnpm test\nDirectory:\nC:\\dev\\example', control_hint:'Demo',settings:{model:'gpt-6.1-sol',effort:'high',approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},settings_token:'demo-settings-1'},
    {id:'demo2', session_id:'demo2', label:'Unit tests', state:'running', reason:'Working', detail:'', project:'C:\\dev\\example', actions:[], control_token:'-', review:'', control_hint:'Demo',settings:{model:'gpt-6-luna',effort:'medium',approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},settings_token:'demo-settings-2'},
    {id:'demo3', session_id:'demo3', label:'Documentation', state:'idle', reason:'Turn stopped', detail:'', project:'C:\\dev\\example', actions:[], control_token:'-', review:'', control_hint:'Demo',settings:{model:'gpt-6.1-sol',effort:'medium',approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},settings_token:'demo-settings-3'},
  ]});

  function visual() {
    mascots?.observe({...c.snapshot,connected:c.snapshot.connected||demo||c.snapshot.rows.some(r=>r.comfy?.connected)});
    const mascot=mascots?.frame(c.preferences.mascot,c.row,c.row?.comfy?c.row.comfy.connected:c.snapshot.connected||demo)??null;
    return {svg:displaySvg(c,mascot?.image),mascot};
  }
  function view() { return {snapshot:c.snapshot, selected:c.selected, page:c.page, cursor:c.cursor,
    menu:c.menu, review:c.row, confirmation:c.confirm, busy:c.busy, notice:c.notice, preferences:c.preferences, canApprove:c.canApprove,
    device:{connected:device.connected, ready:protocol.ready && keysReady && !remapping, keysReady, error:deviceError},
    inputMode:'Direct USB', demo, comfyConnections:comfy.configs(), modelLabel:modelLabel(c.row,c.snapshot),effortLabel:effortLabel(c.row?.settings?.effort),canChooseModel:c.canChooseModel,...visual()}; }
  function publish() { if (win && !win.isDestroyed()) win.webContents.send('view', view()); }
  async function execute(intent?: Intent) {
    if (!intent || c.busy) return;
    if(intent.method==='comfy-focus'){
      const url=comfy.url(String(intent.params.id));if(url)await shell.openExternal(url);return;
    }
    if(!backend)return;
    c.busy = true; publish();
    try { codexSnapshot=await backend.request(intent.method, intent.params);syncSnapshot(); c.notice = intent.method==='configuration'?'Settings updated · next turn':'Action confirmed'; }
    catch (e) { c.notice = String((e as Error).message); }
    finally { c.busy = false; publish(); }
  }
  async function key(index: number) {
    const intent = c.key(index); publish(); await execute(intent);
  }
  async function control(name:string){
    if(c.busy)return;
    let intent:Intent|undefined;
    if(name==='previous')c.rotate(-1);else if(name==='next')c.rotate(1);
    else if(name==='press')intent=c.press();else if(name==='plus')c.toggleGlobal();else if(name==='minus')c.cancelOrBack();
    else throw new Error('Invalid control');
    writeFileSync(preferenceFile,JSON.stringify(c.preferences)); publish(); await execute(intent);
  }
  const createWindow = () => {
    win = new BrowserWindow({width:1080, height:760, minWidth:850, minHeight:620,show:!process.env.PULSAR_SMOKE_DIR,
      backgroundColor:'#101822', title:'Pulsar Codex Deck',
      webPreferences:{preload:join(__dirname,'../preload/index.js'), contextIsolation:true, nodeIntegration:false, sandbox:true,offscreen:!!process.env.PULSAR_SMOKE_DIR}});
    if(process.env.PULSAR_SMOKE_DIR)win.webContents.on('paint',(_event,_dirty,image)=>{lastPaint=image.toPNG();});
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', e => e.preventDefault());
    void win.loadFile(join(root,'ui/index.html'));
    win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  };
  createWindow();
  app.on('second-instance', () => { win.show(); win.focus(); });
  app.on('activate', () => { win.show(); win.focus(); });
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="7" fill="#73d9bd"/><path d="M13 9L6 16L13 23M19 9L26 16L19 23" stroke="#101b26" stroke-width="3" fill="none"/></svg>`;
  const sharp = (await import('sharp')).default;
  tray = new Tray(nativeImage.createFromBuffer(await sharp(Buffer.from(traySvg)).png().toBuffer()));
  tray.setToolTip('Pulsar Codex Deck');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Open controller',click:()=>win.show()}, {label:'Quit',click:()=>app.quit()}]));
  tray.on('double-click',()=>win.show());
  ipcMain.handle('view', () => view());
  ipcMain.handle('key', (_e, index) => { if (![0,1,2].includes(index)) throw Error('Invalid key'); return key(index); });
  ipcMain.handle('select', (_e,id) => { c.select(String(id)); publish(); });
  ipcMain.handle('back', () => { if (!c.busy) c.back(); publish(); });
  ipcMain.handle('control',(_e,name)=>control(name));
  ipcMain.handle('comfy-save',(_e,value)=>{
    if(demo||c.busy)throw Error('Connections cannot be changed right now.');
    const config=connection(value),configs=comfy.configs(),index=configs.findIndex(x=>x.id===config.id);
    if(index<0){if(configs.length>=8)throw Error('Up to eight connections are supported.');configs.push(config);}else configs[index]=config;
    if(configs.some(x=>x.id!==config.id&&x.url===config.url))throw Error('That server URL is already connected.');
    writeFileSync(comfyFile,JSON.stringify(configs,null,2));comfy.configure(configs);void comfy.tick();
  });
  ipcMain.handle('comfy-remove',(_e,id)=>{
    if(demo||c.busy)throw Error('Connections cannot be changed right now.');
    const configs=comfy.configs().filter(x=>x.id!==id);
    writeFileSync(comfyFile,JSON.stringify(configs,null,2));comfy.configure(configs);
  });
  ipcMain.handle('comfy-test',(_e,value)=>comfy.test(value));
  ipcMain.handle('comfy-helper',async()=>{
    if(demo)return;
    const result=await dialog.showOpenDialog(win,{title:'Select your ComfyUI folder (contains main.py and custom_nodes)',properties:['openDirectory']});
    if(result.canceled)return 'Installation cancelled.';
    const folder=result.filePaths[0];
    if(!existsSync(join(folder,'main.py'))||!existsSync(join(folder,'server.py'))||!existsSync(join(folder,'custom_nodes')))throw Error('Select the ComfyUI folder containing main.py, server.py and custom_nodes.');
    const destination=join(folder,'custom_nodes/pulsar_deck'),file=join(destination,'__init__.py');
    const source=readFileSync(join(root,'comfyui/pulsar_deck/__init__.py'),'utf8');
    if(existsSync(file)){
      const previous=readFileSync(file,'utf8');
      if(previous!==source){
        if(!previous.startsWith('"""Optional read-only ComfyUI progress endpoint for Pulsar Codex Deck.'))throw Error('A different pulsar_deck extension already exists in this folder.');
        writeFileSync(file+'.'+Date.now()+'.bak',previous);
      }
    }
    mkdirSync(destination,{recursive:true});writeFileSync(file,source);
    return 'Progress helper installed. Restart this ComfyUI instance when its queue is finished to enable node and total progress.';
  });
  ipcMain.handle('mascot',(_e,value)=>{
    if(c.busy)return;
    c.setMascot(value);writeFileSync(preferenceFile,JSON.stringify(c.preferences));publish();
  });
  ipcMain.handle('setup',async()=>{
    if(!backend||c.busy)return;
    const response=await dialog.showMessageBox(win,{type:'question',title:'Connect Codex',
      message:'Install observational Codex hooks?',
      detail:'Existing hooks will be preserved and backed up. These hooks report session status only. After installation, run /hooks in Codex to review and trust them.',
      buttons:['Install hooks','Cancel'],defaultId:0,cancelId:1});
    if(response.response!==0)return;
    c.busy=true;publish();
    try{const snapshot=await backend.request('setup-hooks');codexSnapshot=snapshot;syncSnapshot();c.notice=snapshot.setup_message||'Hooks installed. Run /hooks in Codex to review and trust them.';}
    catch(e){c.notice=String((e as Error).message);}
    finally{c.busy=false;publish();}
  });
  ipcMain.handle('action', (_e,verb) => {
    if(verb==='image'){if(c.row?.comfy?.latest&&!c.busy){c.page='image';c.displayedApproval=null;}publish();return;}
    if(verb==='model'){c.openConfiguration();publish();return;}
    if (verb === 'review') { if (c.row?.review && !c.busy) { c.page='details';c.cursor=0; } publish(); return; }
    if (verb === 'settings') { if (c.row?.settings && !c.busy) { c.page='settings'; c.cursor=0; } publish(); return; }
    if (verb === 'approve' || verb === 'reject') {
      if(verb==='approve')return key(0);
      return execute(c.action(verb));
    }
    if (!['focus','stop','continue'].includes(verb)) throw Error('Invalid action');
    return execute(c.action(verb));
  });
  // Vendor input remains available when a game captures ordinary keyboard keys.
  const onDirectInput=(packet:Buffer)=>{
    if(!keysReady||remapping||quitting)return;
    for(const name of directInput.update(packet)){
      console.log(`[input] direct ${name}`);
      if(name.startsWith('key'))void key(Number(name.slice(3))-1);
      else void control(name);
    }
  };
  protocol.onReady = () => {
    keysReady=false;directInput.reset();
    if(!device.aux){deviceError='Direct USB input channel unavailable. Reconnect the pad.';publish();return;}
    remapping = true; publish();
    void protocol.remapPadKeys([{mod:0,key:0},{mod:0,key:0},{mod:0,key:0}])
      .then(()=>protocol.remapKnob(true))
      .then(()=>{directInput.reset();keysReady=true;})
      .catch(async e=>{keysReady=false; deviceError=String(e); await protocol.restoreKeys();})
      .finally(()=>{remapping=false; lastSvg=''; cachedFrame=null; publish();});
  };
  device.on('connect',()=>{device.aux?.on('data',onDirectInput);publish();});
  device.on('disconnect',()=>{directInput.reset();auxiliaryButtons.reset();keysReady=false; c.back(); lastSvg=''; cachedFrame=null; publish();});
  if (!noDevice) device.start();
  const poll = async () => {
    if(existsSync(quitFile)){unlinkSync(quitFile);app.quit();return;}
    if (!backend || polling || c.busy || quitting) return;
    polling=true;
    try { codexSnapshot=await backend.request('refresh');syncSnapshot(); }
    catch(e) { codexSnapshot={...codexSnapshot,connected:false,error:String((e as Error).message),rows:codexSnapshot.rows.map(r=>({...r,actions:[],control_token:'-',settings:undefined,settings_token:undefined}))};syncSnapshot(); }
    finally { polling=false; publish(); }
  };
  void poll();
  const pollTimer = setInterval(()=>{void poll();},1000);
  if(!demo)void comfy.tick();
  const comfyTimer=setInterval(()=>{if(!demo&&!quitting)void comfy.tick();},1000);
  // Animation messages update only images, leaving buttons stable during clicks.
  let lastAnimation='';
  const animationTimer=setInterval(()=>{
    if(quitting||!win||win.isDestroyed()||(!win.isVisible()&&!process.env.PULSAR_SMOKE_DIR))return;
    const frame=visual(),signature=frame.svg+':'+frame.mascot?.choice+':'+frame.mascot?.state+':'+frame.mascot?.index;
    if(signature!==lastAnimation){lastAnimation=signature;win.webContents.send('animation',frame);}
  },100);
  const buttonTimer=setInterval(async()=>{
    if(!protocol.ready||remapping||drawing||readingButtons||quitting)return;
    readingButtons=true;
    try{
      const state=await protocol.readButtonState();
      if(++buttonReads===1)console.log(`[input] raw button monitor ready; state=${state.toString(16)}`);
      if(!remapping&&!quitting){
        for(const name of auxiliaryButtons.update(state)){
          console.log(`[input] physical ${name}: ${c.page}`);
          await control(name);
          console.log(`[input] screen: ${c.page}`);
        }
      }
    }catch(e){if(Date.now()-lastButtonError>5000){lastButtonError=Date.now();console.error('[input]',String(e));}}
    finally{readingButtons=false;}
  },25);
  const drawTimer = setInterval(async()=>{
    if (!protocol.ready || remapping || drawing || readingButtons || quitting) return;
    drawing=true;
    try {
      if(await protocol.checkSettingsButton()){
        // Profile protection only. Raw bits 16/17 own the +/× actions.
        keysReady=false;directInput.reset();
        await protocol.remapPadKeys([{mod:0,key:0},{mod:0,key:0},{mod:0,key:0}]);
        await protocol.remapKnob(true);directInput.reset();keysReady=true;publish();
      }
      const svg=visual().svg,row=c.row?structuredClone(c.row):null,signature=svg+':'+c.preferences.brightness;
      if (signature!==lastSvg || !cachedFrame) {
        cachedFrame=frameCache.get(signature)??await rgb565(svg,c.preferences.brightness);lastSvg=signature;
        frameCache.set(signature,cachedFrame);
        if(frameCache.size>24)frameCache.delete(frameCache.keys().next().value!);
      }
      const colors = c.snapshot.rows.some(r=>r.state==='waiting') ? [105,65,10] :
        c.snapshot.rows.some(r=>r.state==='error') ? [110,20,30] :
        c.snapshot.rows.some(r=>r.state==='running'||r.state==='queued') ? [15,50,110] : [15,75,55];
      protocol.setLeds(Array.from({length:13},()=>({r:c.preferences.lights?colors[0]:0,g:c.preferences.lights?colors[1]:0,b:c.preferences.lights?colors[2]:0})));
      const sent=await protocol.drawLcdFrame(cachedFrame);
      if(row&&sent){const was=c.canApprove;c.markDisplayed(row.id,row.session_id,row.control_token);if(was!==c.canApprove)publish();}
    } catch(e) { deviceError=String(e); publish(); }
    finally {drawing=false;}
  },100);
  app.on('before-quit', e=>{
    if (quitting) return;
    e.preventDefault(); quitting=true;
    clearInterval(pollTimer); clearInterval(drawTimer); clearInterval(buttonTimer);clearInterval(animationTimer);clearInterval(comfyTimer);comfy.close();
    void (async()=>{
      // Finish any in-flight LCD burst before restoring mappings.
      while(drawing || remapping || readingButtons) await new Promise(r=>setTimeout(r,20));
      await protocol.restoreKeys(); device.stop();
      backend?.close(); tray?.destroy(); app.quit();
    })();
  });
  if (process.env.PULSAR_SMOKE_DIR) {
    const folder=process.env.PULSAR_SMOKE_DIR; mkdirSync(folder,{recursive:true});
    setTimeout(async()=>{try{
      writeFileSync(join(folder,'status.json'),JSON.stringify(view(),null,2));
      writeFileSync(join(folder,'lcd.png'),await sharp(Buffer.from(visual().svg)).png().toBuffer());
      writeFileSync(join(folder,'dashboard.png'),lastPaint||(await win.webContents.capturePage()).toPNG());
    }catch(e){console.error('Smoke capture failed',e);}finally{app.quit();}
    },12000);
  }
  if (!existsSync(packagedBackend || python) && !demo) c.notice=app.isPackaged?'Backend missing. Reinstall Pulsar Codex Deck.':'Run npm run setup once to install the local Python environment.';
}
