import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files=['index.html','manifest.json','src/styles.css','src/app.js','src/config.js','src/audio-engine.js',
  'src/sync-engine.js','src/network.js','src/transfer.js','src/ui.js','src/track-store.js','src/network-quality.js',
  'shared/protocol.js','assets/icon-192.png','assets/icon-512.png','assets/upi-qr.png'];
const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
for(const icon of manifest.icons)await access(resolve(root,icon.src));
const hash=createHash('sha256');let bytes=0;
for(const file of files){const data=await readFile(resolve(root,file));hash.update(file);hash.update(data);bytes+=data.length;}
const worker=await readFile(resolve(root,'sw.js'),'utf8');hash.update(worker);
const revision=hash.digest('hex').slice(0,20);
// Copy only known public files. Never delete arbitrary prior build contents.
for(const file of files){const target=resolve(root,'dist',file);await mkdir(dirname(target),{recursive:true});await copyFile(resolve(root,file),target);}
await writeFile(resolve(root,'dist/sw.js'),worker.replace('__SHELL_REVISION__',revision));
await writeFile(resolve(root,'dist/.nojekyll'),'');
const report={revision,files:files.length+1,totalShellBytes:bytes+Buffer.byteLength(worker),kind:'verified static ES-module artifact; no compilation required'};
await writeFile(resolve(root,'dist/build-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
