const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'..');
(async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="8" y="8" width="240" height="240" rx="56" fill="#101925"/><path d="M99 73L44 128L99 183M157 73L212 128L157 183" stroke="#7ed9bd" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="128" cy="128" r="12" fill="#ffc76b"/></svg>';
 fs.mkdirSync(path.join(root,'packaging'),{recursive:true});
 const png=await sharp(Buffer.from(svg)).png().toBuffer();fs.writeFileSync(path.join(root,'packaging/icon.png'),png);
 const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
 fs.writeFileSync(path.join(root,'packaging/icon.ico'),Buffer.concat([header,png]));
})();
