import {X509Certificate,verify} from 'node:crypto';
import {createQzSigningPrototype} from '../homologation/qzSigningPrototype.js';
import {createQzSigningPrototypeRouter} from '../homologation/qzSigningPrototypeRoutes.js';

const instances=new WeakSet();
const unavailable=()=>Object.assign(new Error('Assinatura QZ segura indisponível.'),{code:'QZ_UNAVAILABLE',statusCode:503});

// An environment flag cannot install this runtime. The reused engine requires a
// loopback disposable database/schema before SQL; no operational key is loaded.
export async function createQzSecureSigning({db,origins,sessionSecret,signDigest,certificate,deriveDocument,now=()=>new Date(),env=process.env}={}) {
    if(env.NODE_ENV!=='test' || env.QZ_SIGNING_MODE!=='secure-test' || typeof signDigest!=='function' || typeof certificate!=='string' || !certificate.trim())throw unavailable();
    let publicIdentity;
    try{publicIdentity=new X509Certificate(certificate);}catch{throw unavailable();}
    const service=await createQzSigningPrototype({db,origins,sessionSecret,signDigest,deriveDocument,now,
        verifyDigest:(digest,signature)=>verify('RSA-SHA512',Buffer.from(digest,'utf8'),publicIdentity.publicKey,Buffer.from(signature,'base64'))});
    const runtime=Object.freeze({mode:'secure-test',service,router:createQzSigningPrototypeRouter({service,secureContract:true})});
    instances.add(runtime);return runtime;
}

export function qzSecureRuntimeAvailable(runtime) {return instances.has(runtime);}

export async function installQzSecureSigning({app,...options}) {
    if(!app?.locals)throw unavailable();
    const runtime=await createQzSecureSigning(options);app.locals.qzSecureSigning=runtime;return runtime;
}
