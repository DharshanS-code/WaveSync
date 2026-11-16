import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let checked=0;
for(const folder of ['src','shared','backend','scripts','tests']){
  for(const name of await readdir(resolve(root,folder))){
    if(!/\.(js|mjs)$/.test(name))continue;
    const file=resolve(root,folder,name);
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.status!==0){console.error(result.stderr);process.exit(1);}
    const text=await readFile(file,'utf8');
    for(const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g))await access(resolve(dirname(file),match[1]));
    checked++;
  }
}
const sw=spawnSync(process.execPath,['--check',resolve(root,'sw.js')],{encoding:'utf8'});
if(sw.status!==0){console.error(sw.stderr);process.exit(1);}
const manifest=JSON.parse(await readFile(resolve(root,'manifest.json'),'utf8'));
for(const icon of manifest.icons)await access(resolve(root,icon.src));
console.log(`Syntax, relative module paths, and manifest assets verified (${checked+1} JavaScript files).`);
