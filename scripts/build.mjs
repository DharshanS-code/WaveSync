import { readFile, writeFile, mkdir, readdir, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSignalUrl } from '../src/config.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const common = ['manifest.json','src/styles.css','src/app.js','src/config.js','src/audio-engine.js',
  'src/sync-engine.js','src/network.js','src/transfer.js','src/ui.js','src/track-store.js','src/network-quality.js',
  'src/preferences.js','src/settings-controller.js','src/qr.js','src/bootstrap.js','src/motion.js',
  'shared/protocol.js','LICENSE','assets/favicon.svg','assets/apple-touch-icon-180.png',
  'assets/wavesync-mark-light.svg','assets/wavesync-mark-dark.svg','assets/wavesync-mark-mono.svg',
  'assets/wavesync-lockup-light.svg','assets/wavesync-lockup-dark.svg','assets/wavesync-lockup-mono.svg',
  'assets/wavesync-icon-192.png','assets/wavesync-icon-512.png','assets/wavesync-maskable-192.png',
  'assets/wavesync-maskable-512.png','assets/wavesync-share-1200x630.png','assets/wavesync-share.svg'];
const fragments = {HEAD:'head',NAV:'nav',COMMUNITY:'community',CREDIT:'credit',FOOTER:'footer',ABOUT:'about',VIEWS:'views'};
const neutral = {
  HEAD:'',NAV:'',COMMUNITY:'<a href="./LICENSE">License &amp; source attribution</a>',CREDIT:'',VIEWS:'',
  FOOTER:'<footer id="home-footer" class="home-footer"><span>WaveSync · <span data-operator>Independent deployment</span></span><nav aria-label="Footer"><a href="#privacy">Privacy Policy</a><a href="./LICENSE">License</a></nav></footer>',
  ABOUT:'<section id="settings-about" class="settings-section" aria-labelledby="about-heading"><h2 id="about-heading">About WaveSync</h2><p>Local music, shared directly. <span data-operator>Independently operated.</span></p><p id="build-info">Source development build</p><a class="text-link" href="./LICENSE">License &amp; source attribution</a></section>'
};
const digest = data => createHash('sha256').update(data).digest('hex');
function safeName(name) { return typeof name === 'string' && /^[a-zA-Z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(part=>part==='..'||part==='.'||!part); }
async function inventory(directory, prefix='') {
  const stat = await lstat(directory);
  if(stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Build output must be a real directory, not a symlink.');
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=resolve(directory,entry.name), name=prefix+entry.name;
    if(entry.isSymbolicLink())throw new Error('Unexpected symlink in build output.');
    if(entry.isDirectory())result.push(...await inventory(path,name+'/'));
    else if(entry.isFile())result.push(name);
    else throw new Error('Unexpected build output entry.');
  }
  return result;
}
async function validateOwnedOutput(output) {
  let names;
  try { names=await inventory(output); } catch(error) { if(error.code==='ENOENT')return; throw error; }
  if(!names.length)return;
  let owner;
  try {owner=JSON.parse(await readFile(resolve(output,'build-inventory.json'),'utf8'));}catch{throw new Error('Unexpected unowned output files; choose a new empty build directory.');}
  if(owner.owner!=='wavesync-static-build-v1' || !owner.files || typeof owner.files!=='object' || Array.isArray(owner.files))throw new Error('Unexpected unowned build inventory.');
  for(const name of Object.keys(owner.files))if(!safeName(name))throw new Error('Unsafe build inventory path.');
  const known=new Set([...Object.keys(owner.files),'build-inventory.json']);
  for(const name of names){
    if(!known.has(name))throw new Error(`Unexpected unowned output file: ${name}`);
    if(name!=='build-inventory.json' && digest(await readFile(resolve(output,name)))!==owner.files[name])throw new Error(`Modified build output file must be reviewed before replacing: ${name}`);
  }
}
export async function buildProfile({profile='self-hosted', output=resolve(root,'dist',profile), deployment}={}) {
  if(!['self-hosted','official'].includes(profile))throw new Error('Choose self-hosted or official build profile.');
  output=resolve(output);
  const under=relative(root,output);
  if(!under || under.startsWith('..'+sep)||under==='..'||!['dist','test-results'].includes(under.split(sep)[0]))throw new Error('Build output must be below this project dist or test-results directory.');
  // Refuse symlinked parents before writing staging content.
  let parent=dirname(output);
  while(parent!==root){try{if((await lstat(parent)).isSymbolicLink())throw new Error('Build parent must not be a symlink.');}catch(error){if(error.code!=='ENOENT')throw error;}parent=dirname(parent);}
  const settings=deployment ?? JSON.parse(await readFile(resolve(root,profile==='official'?'official/deployment.json':'config/deployment.json'),'utf8'));
  const signalUrl=settings.signalUrl || '';
  if(signalUrl && new URL(validateSignalUrl(signalUrl,{protocol:'https:'})).protocol!=='wss:')throw new Error('Public signaling requires wss://.');
  const config={profile,signalUrl,name:'WaveSync',operator:typeof settings.operator==='string'?settings.operator.slice(0,120):'',
    providerNote:typeof settings.providerNote==='string'?settings.providerNote.slice(0,1200):(profile==='official'?'The public signaling service uses Cloudflare. Default STUN discovery uses Google; provider retention policies are separate.':'This deployment is operated independently. Ask its operator about signaling and hosting providers.')};
  const emitted=new Map();
  for(const file of common)emitted.set(file,await readFile(resolve(root,file)));
  let html=await readFile(resolve(root,'index.html'),'utf8');
  for(const [marker,name]of Object.entries(fragments)){
    const token=`<!-- PROFILE_${marker} -->`;
    if(html.split(token).length!==2)throw new Error(`Expected one ${token} template marker.`);
    html=html.replace(token,profile==='official'?await readFile(resolve(root,'official',`${name}.html`),'utf8'):neutral[marker]);
  }
  if(profile==='official'){
    html=html.replace('src="./src/bootstrap.js"','src="./official/bootstrap.js"');
    for(const name of ['bootstrap.js','support.js','features.js','support.css'])emitted.set(`official/${name}`,await readFile(resolve(root,'official',name)));
    emitted.set('config/features.json',await readFile(resolve(root,'config/features.json')));
  }
  emitted.set('index.html',Buffer.from(html));
  emitted.set('src/deployment.js',Buffer.from(`// Generated public deployment settings. No credentials.\nexport const DEPLOYMENT = Object.freeze(${JSON.stringify(config)});\n`));
  const packageInfo=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  let worker=await readFile(resolve(root,'sw.js'),'utf8');
  const shell=[...emitted.keys()].filter(name=>name!=='config/features.json');shell.push('build-info.json');
  worker=worker.replace(/const SHELL = \[[\s\S]*?\];/,`const SHELL = ${JSON.stringify(shell.map(name=>'./'+name),null,2)};`);
  const hash=createHash('sha256');hash.update(profile);hash.update(packageInfo.version);hash.update(worker);
  for(const [name,bytes]of [...emitted].sort(([a],[b])=>a.localeCompare(b))){hash.update(name);hash.update(bytes);}
  const revision=hash.digest('hex').slice(0,20);
  emitted.set('sw.js',Buffer.from(worker.replace('__SHELL_REVISION__',revision)));
  emitted.set('build-info.json',Buffer.from(JSON.stringify({version:packageInfo.version,revision,profile})+'\n'));
  emitted.set('.nojekyll',Buffer.alloc(0));
  const report={profile,revision,files:emitted.size,totalShellBytes:[...emitted.values()].reduce((sum,data)=>sum+data.length,0),kind:'profile-isolated native ES-module artifact'};
  emitted.set('build-report.json',Buffer.from(JSON.stringify(report,null,2)+'\n'));
  const owned={owner:'wavesync-static-build-v1',profile,revision,files:Object.fromEntries([...emitted].map(([name,bytes])=>[name,digest(bytes)]))};
  emitted.set('build-inventory.json',Buffer.from(JSON.stringify(owned,null,2)+'\n'));
  await validateOwnedOutput(output);
  await mkdir(dirname(output),{recursive:true});
  const stage=await mkdtemp(resolve(dirname(output),'.wavesync-stage-'));let backup;
  try{
    for(const [name,bytes]of emitted){const target=resolve(stage,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);}
    await validateOwnedOutput(output);
    try { await lstat(output); backup=await mkdtemp(resolve(dirname(output),'.wavesync-previous-')); await rm(backup,{recursive:true});await rename(output,backup); }catch(error){if(error.code!=='ENOENT')throw error;}
    try {await rename(stage,output);}catch(error){if(backup)await rename(backup,output);throw error;}
    if(backup)await rm(backup,{recursive:true,force:true});
  }finally{await rm(stage,{recursive:true,force:true});}
  return report;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const index=process.argv.indexOf('--profile');
  const profile=index>=0?process.argv[index+1]:'self-hosted';
  console.log(JSON.stringify(await buildProfile({profile}),null,2));
}
