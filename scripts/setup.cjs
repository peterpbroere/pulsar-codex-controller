const {spawnSync}=require('node:child_process');
const {existsSync}=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),win=process.platform==='win32';
function run(command,args){const r=spawnSync(command,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
const python=path.join(root,win?'.venv/Scripts/python.exe':'.venv/bin/python');
if(!existsSync(python)){
 const candidates=process.env.PULSAR_PYTHON?[{cmd:process.env.PULSAR_PYTHON,args:[]}]:win?[{cmd:'py',args:['-3']},{cmd:'python',args:[]}]:[{cmd:'python3',args:[]}];
 const found=candidates.find(x=>spawnSync(x.cmd,[...x.args,'--version'],{windowsHide:true}).status===0);
 if(!found){console.error('Install Python 3.9+ to develop from source. Packaged Windows releases include Python.');process.exit(1);}
 run(found.cmd,[...found.args,'-m','venv','.venv']);
}
run(python,['-m','pip','install','-r','python/requirements.txt']);
console.log('Setup complete. Run npm start. In the app, use Connect Codex, then review/trust the hooks with /hooks.');
