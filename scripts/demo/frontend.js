import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { privateDirectory } from './environment.js';

const directory=fileURLToPath(new URL('../../../Saas-Marmitaria-Frontend/',import.meta.url));
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','55445',
    '--experimental-https','--experimental-https-cert',join(privateDirectory,'localhost.pem'),'--experimental-https-key',join(privateDirectory,'localhost-key.pem'),
    '--experimental-https-ca',join(privateDirectory,'localhost.pem')],{
    cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',
        NEXT_PUBLIC_INFINITEPAY_DEMO:'local-only',NEXT_PUBLIC_API_URL:'https://localhost:55446',CHECKOUT_BACKEND_URL:'https://localhost:55446',
        NEXT_PUBLIC_SITE_URL:'https://localhost:55445',CHECKOUT_SITE_ORIGIN:'https://localhost:55445',NEXT_PUBLIC_QZ_CERTIFICATE:'',
        INFINITEPAY_ENCRYPTION_KEY:'',INFINITEPAY_ENCRYPTION_KEYS:'',JWT_SECRET:'',DATABASE_URL:'',DB_PASSWORD:''}
});
function sanitize(value){return String(value).replace(/\x1b\[[0-9;]*m/g,'').replace(/(\/[\w/.-]*)\?[^\s]*/g,'$1?[REDACTED]')
    .replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi,'[ID]').replace(/\b[A-Za-z0-9_-]{43}\b/g,'[CAPABILITY]');}
for(const stream of [child.stdout,child.stderr]){
    let pending='';stream.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){console.log(sanitize(pending.slice(0,end)));pending=pending.slice(end+1);}});
    stream.on('end',()=>{if(pending)console.log(sanitize(pending));});
}
child.on('error',()=>{console.error('Frontend de demonstração indisponível.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
