const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const errors=[];
for(const file of files){
 if(/^(work|build|release|dist|node_modules|vendor|\.venv)\//.test(file)||/\.sqlite3|\.log$|\.pfx$|\.pem$|\.key$/.test(file))errors.push('Private/generated file tracked: '+file);
 if(!/\.(png|ico)$/.test(file)){
  const text=fs.readFileSync(file,'utf8');
  if(/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text))errors.push('Possible credential in '+file);
  if(/C:[\\/]+Users[\\/]+peter(?:[\\/]|\b)/i.test(text))errors.push('Private machine path in '+file);
 }
}
if(errors.length){console.error(errors.join('\n'));process.exit(1);}
console.log(`Reviewed ${files.length} tracked files: no private runtime folders, credential patterns or personal machine paths found.`);
