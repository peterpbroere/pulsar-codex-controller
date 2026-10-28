const {spawn}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const child=spawn(require('electron'),[root,...process.argv.slice(2)],{
 cwd:root,env:{...process.env,PULSAR_SMOKE_DIR:process.env.PULSAR_SMOKE_DIR||path.join(root,'work','smoke-live')},windowsHide:true,stdio:'inherit'});
child.on('exit',code=>process.exitCode=code||0);
