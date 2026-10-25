import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { join } from 'node:path';
import { providerOrigins } from '../../src/config/infinitepayProviderOrigins.js';

export const privateDirectory = fileURLToPath(new URL('../../../infinitepay-demo-private/',import.meta.url));
export async function loadDemoEnvironment() {
    const profile=JSON.parse(await readFile(new URL('../../../infinitepay-demo-private/profile.json',import.meta.url),'utf8'));
    if(profile.purpose !== 'INFINITEPAY_LOCAL_SIMULATION_ONLY' || !/^[A-Za-z0-9_-]{43}$/.test(profile.operatorToken || '') ||
        !profile.adminPassword || !profile.encryptionKey || !profile.jwtSecret) throw new Error('Perfil de demonstração inválido.');
    Object.assign(process.env, {NODE_ENV:'development',INFINITEPAY_MODE:'homologation',INFINITEPAY_DEMO:'local-only',
        DB_HOST:'127.0.0.1',DB_PORT:'55439',DB_NAME:'infinitepay_phase1_test',DB_USER:'codex_test',DB_PASSWORD:'',DATABASE_URL:'',
        PGOPTIONS:'-c search_path=infinitepay_demo',INFINITEPAY_DATABASE_NAME:'infinitepay_phase1_test',INFINITEPAY_CHECKOUT_ENABLED:'true',
        INFINITEPAY_PUBLIC_ORIGIN:'https://localhost:55446',INFINITEPAY_SUCCESS_URL:'https://localhost:55445/pedido/sucesso',
        INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'https://localhost:55445,https://localhost:55446',ALLOWED_ORIGINS:'https://localhost:55445,https://localhost:55446',
        INFINITEPAY_ENCRYPTION_KEY:profile.encryptionKey,INFINITEPAY_ENCRYPTION_KEYS:'',JWT_SECRET:profile.jwtSecret});
    providerOrigins();
    return profile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const action=process.argv[2];if(!['status','stop'].includes(action))throw new Error();
        const profile=await loadDemoEnvironment();
        const certificate=await readFile(join(privateDirectory,'localhost.pem'));
        const response=await new Promise((resolve,reject)=>{
            const call=request({hostname:'127.0.0.1',servername:'localhost',port:55446,path:action==='status'?'/__demo/health':'/__demo/stop',
                method:action==='status'?'GET':'POST',ca:certificate,headers:{Host:'localhost:55446',...(action==='stop'?{'X-Demo-Operator':profile.operatorToken}:{})}},reply=>{
                let text='';reply.setEncoding('utf8');reply.on('data',chunk=>{text+=chunk;if(text.length>8192)call.destroy();});
                reply.on('end',()=>reply.statusCode===200?resolve(JSON.parse(text)):reject(new Error()));
            });
            call.setTimeout(5000,()=>call.destroy());call.on('error',reject);call.end();
        });
        console.log(JSON.stringify(response));
    } catch {console.error('Serviço local indisponível ou certificado inválido.');process.exitCode=1;}
}
