import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDevServer } from '../backend/dev-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
export function createStaticServer({port=3000,host='127.0.0.1',directory=root}={}) {
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const path=decodeURIComponent(url.pathname);
      const relative=path==='/'?'index.html':path.replace(/^\//,'');
      if(!/^(index\.html|manifest\.json|build-info\.json|config\/features\.json|sw\.js|src\/[a-z0-9-]+\.(js|css)|shared\/protocol\.js|assets\/[a-z0-9-]+\.(png|svg)|official\/[a-z0-9-]+\.(js|css)|LICENSE)$/.test(relative)){
        res.writeHead(404);res.end('Not found');return;
      }
      const file=resolve(directory,relative);
      if(!file.startsWith(resolve(directory)+sep)||!(await stat(file)).isFile())throw new Error('Not found');
      const bytes=await readFile(file);
      res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream',
        'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(bytes);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  server.listen(port,host);return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const profileIndex=process.argv.indexOf('--profile');
  const profile=profileIndex>=0?process.argv[profileIndex+1]:null;
  if(profile && !['official','self-hosted'].includes(profile))throw new Error('Choose official or self-hosted.');
  const staticServer=createStaticServer({directory:profile?resolve(root,'dist',profile):root});
  const signal=process.argv.includes('--static-only')?null:createDevServer();
  console.log('WaveSync: http://localhost:3000 (signaling ws://localhost:8787/api/room)');
  const close=()=>{staticServer.close();signal?.close();};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  staticServer.on('error',error=>{console.error(error.message);close();process.exitCode=1;});
  signal?.on('error',error=>{console.error(error.message);close();process.exitCode=1;});
}
