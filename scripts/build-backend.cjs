const {spawnSync}=require('node:child_process');
const path=require('node:path');
if(process.platform!=='win32'){console.error('Build the Windows backend on Windows.');process.exit(1);}
const root=path.resolve(__dirname,'..'),python=process.env.PULSAR_BUILD_PYTHON||path.join(root,'.venv/Scripts/python.exe');
for(const args of [['-m','pip','install','-r','python/requirements-build.txt'],['-m','PyInstaller','--noconfirm','--clean','--distpath','build/backend','--workpath','build/pyinstaller','packaging/backend.spec']]){
 const r=spawnSync(python,args,{cwd:root,stdio:'inherit',windowsHide:true});if(r.error){console.error(r.error.message);process.exit(1);}if(r.status!==0)process.exit(r.status||1);
}
