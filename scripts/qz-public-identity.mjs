import {createHash,createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export const historicalCertificateSha256='907a49d1b48c22c83e551c2b67a1c9c6942c608a098fa0dfa9a14588d050cd5d';
export const historicalSpkiSha256='e25482ebe44e0076a3dce8310c7d5c0ccfe8a1027f44cda92df4e7adc89659c9';
const denied=()=>new Error('Conferência pública QZ indisponível.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function inspectKeyPublicIdentity(value) {
    try {
        if(typeof value!=='string' || !value.trim())throw denied();
        const key=createPrivateKey(value.replace(/\\n/g,'\n')),publicKey=createPublicKey(key);
        const spki_sha256=digest(publicKey.export({type:'spki',format:'der'}));
        return {source:'local_key',spki_sha256,matches_historical_certificate_spki:spki_sha256===historicalSpkiSha256};
    }catch{throw denied();}
}

export function inspectPublicCertificate(value) {
    try {
        if(typeof value!=='string' || !/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+\s+-----END CERTIFICATE-----$/.test(value.trim()))throw denied();
        const cert=new X509Certificate(value),certificate_sha256=digest(cert.raw),spki_sha256=digest(cert.publicKey.export({type:'spki',format:'der'}));
        return {source:'public_certificate',certificate_sha256,spki_sha256,matches_historical_certificate:certificate_sha256===historicalCertificateSha256,
            matches_historical_certificate_spki:spki_sha256===historicalSpkiSha256};
    }catch{throw denied();}
}

async function main(args) {
    if(args.length===2 && args[0]==='--certificate') {
        console.log(JSON.stringify(inspectPublicCertificate(await readFile(args[1],'utf8'))));return;
    }
    if(args.length!==1 || args[0]!=='--environment' || !process.stdin.isTTY)throw denied();
    const prompt=createInterface({input:process.stdin,output:process.stdout});let answer;
    try{answer=await prompt.question('Responsável autorizado: digite CONFERIR IDENTIDADE PUBLICA QZ para ler somente a identidade pública da chave local: ');}finally{prompt.close();}
    if(answer!=='CONFERIR IDENTIDADE PUBLICA QZ')throw denied();
    // No dotenv, private file, command-line key, export, network or free-text error output.
    console.log(JSON.stringify(inspectKeyPublicIdentity(process.env.QZ_PRIVATE_KEY)));
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
    main(process.argv.slice(2)).catch(()=>{console.error('Conferência pública QZ indisponível. Nenhum material privado foi exibido.');process.exitCode=1;});
}
