// Electron 45 installs its runtime lazily. Packaging also needs that binary.
const fs=require('node:fs');
const executable=require('electron');
if(typeof executable!=='string'||!fs.existsSync(executable))throw new Error('Electron runtime installation failed.');
console.log('Electron runtime ready for packaging.');
