import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';

test('local identity inspection returns only public fingerprints for disposable key material',async()=>{
    const {inspectKeyPublicIdentity}=await import('../../scripts/qz-public-identity.mjs');
    const pair=generateKeyPairSync('rsa',{modulusLength:2048}),privatePem=pair.privateKey.export({type:'pkcs8',format:'pem'});
    const result=inspectKeyPublicIdentity(privatePem),expected=createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex');
    assert.equal(result.spki_sha256,expected);assert.equal(result.matches_historical_certificate_spki,false);
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes(privatePem),false);
});
test('identity errors are fixed and never echo malformed private input',async()=>{
    const {inspectKeyPublicIdentity}=await import('../../scripts/qz-public-identity.mjs');
    assert.throws(()=>inspectKeyPublicIdentity('SYNTHETIC_PRIVATE_SECRET'),error=>error.message==='Conferência pública QZ indisponível.');
});
test('public certificate and disposable key identify the same SPKI without exposing either PEM',async()=>{
    const {inspectKeyPublicIdentity,inspectPublicCertificate}=await import('../../scripts/qz-public-identity.mjs');
    const {createSyntheticQzIdentity}=await import('../helpers/qzSigningFixture.js');const identity=await createSyntheticQzIdentity();
    try {
        const publicResult=inspectPublicCertificate(identity.cert),keyResult=inspectKeyPublicIdentity(identity.tls.key.toString());
        assert.equal(publicResult.spki_sha256,keyResult.spki_sha256);assert.match(publicResult.certificate_sha256,/^[a-f0-9]{64}$/);
        assert.equal(publicResult.matches_historical_certificate,false);assert.equal(JSON.stringify(publicResult).includes('BEGIN'),false);
        assert.throws(()=>inspectPublicCertificate(identity.cert+identity.tls.key.toString()),error=>error.message==='Conferência pública QZ indisponível.');
    }finally{await identity.close();}
});
