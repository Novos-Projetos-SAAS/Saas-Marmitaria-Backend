import 'dotenv/config';
import {resolveFinancialEnvironment} from '../src/config/resolveFinancialEnvironment.js';
import {validateProductionEnvironment} from '../src/config/infinitepayProduction.js';
import {parsePostgresUrl} from '../src/config/postgresConnection.js';

// Diagnostic output is deliberately limited to names/statuses; never log
// DATABASE_URL, tokens, passwords, keys, or other environment values.
const raw = process.env;
const findings = [];
const check = (test, message) => {if (!test) findings.push(message);};
const httpsOrigin = value => {
    try {const url=new URL(value);return url.protocol==='https:' && url.href===url.origin+'/';}
    catch {return false;}
};
check(raw.NODE_ENV==='production','Defina NODE_ENV=production.');
check(raw.INFINITEPAY_MODE==='production','Defina INFINITEPAY_MODE=production.');
check(raw.INFINITEPAY_LOCAL_TEST==='true','Defina INFINITEPAY_LOCAL_TEST=true para testar no Windows.');
check(raw.RENDER!=='true' && !raw.RENDER_EXTERNAL_URL,'Não copie RENDER/RENDER_EXTERNAL_URL do Render para o Windows.');
check(!raw.INFINITEPAY_BIND_HOST || raw.INFINITEPAY_BIND_HOST==='127.0.0.1','Em testes locais, INFINITEPAY_BIND_HOST deve ser 127.0.0.1 ou ausente.');
check(!raw.INFINITEPAY_TRUSTED_PROXY_IPS,'Remova INFINITEPAY_TRUSTED_PROXY_IPS no perfil local.');
check(!raw.INFINITEPAY_DEMO,'Remova INFINITEPAY_DEMO de produção.');
check(typeof raw.JWT_SECRET==='string' && raw.JWT_SECRET.length>=32,'JWT_SECRET deve conter pelo menos 32 caracteres.');
const front=raw.FRONTEND_URL;
const backend=raw.INFINITEPAY_PUBLIC_ORIGIN || raw.BACKEND_URL;
check(httpsOrigin(front),'FRONTEND_URL deve ser uma origem HTTPS sem caminho.');
check(httpsOrigin(backend),'BACKEND_URL (ou INFINITEPAY_PUBLIC_ORIGIN) deve ser uma origem HTTPS pública do túnel.');
if(httpsOrigin(backend)) check(!new URL(backend).hostname.endsWith('.onrender.com'),'A URL do Render não aponta para o backend local: use o endereço HTTPS do túnel.');
check(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(raw.INFINITEPAY_DATABASE_ID || ''),
    'INFINITEPAY_DATABASE_ID deve ser o UUID real registrado no banco de testes.');
check(/^[A-Za-z0-9+/]{43}=$/.test(raw.INFINITEPAY_ENCRYPTION_KEY || ''),
    'INFINITEPAY_ENCRYPTION_KEY deve ser Base64 de 32 bytes.');
if (!raw.DATABASE_URL) {
    findings.push('Defina DATABASE_URL com a conexão TLS da Neon.');
} else {
    try {
        const parsed = parsePostgresUrl(raw.DATABASE_URL,{financialProduction:true});
        check(/^[a-z][a-z0-9_]{0,62}$/.test(parsed.database),
            'O nome do banco Neon não atende ao formato exigido em produção.');
    } catch {
        findings.push('DATABASE_URL é inválida para o modo financeiro; verifique protocolo, sslmode e channel_binding.');
    }
}
let env;
try {env=resolveFinancialEnvironment(raw);}
catch {findings.push('Falha ao derivar FRONTEND_URL, BACKEND_URL ou DATABASE_URL.');}
if(env) {
    try {validateProductionEnvironment(env);}
    catch {findings.push('As verificações combinadas de origem/identidade/proxy ainda não passaram.');}
}
if(findings.length) {
    console.error('Configuração local de produção: REPROVADA');
    for (const line of [...new Set(findings)]) console.error('- '+line);
    process.exitCode=1;
} else {
    console.log('Configuração local de produção: APROVADA (sintaxe e regras de ambiente).');
    console.log('Ainda é necessário verificar identidade PostgreSQL, TLS, autorização administrativa e fluxo real de pagamentos.');
}
