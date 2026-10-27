import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('H4 reads a DPAPI credential written by Set-Content without losing it to the trailing newline',()=>{
    const helper=fileURLToPath(new URL('../../scripts/credit/credential.ps1',import.meta.url)).replaceAll("'","''");
    const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',`
        $ErrorActionPreference='Stop'; . '${helper}'
        $path=[IO.Path]::GetTempFileName(); $key=$null; $decoded=$null
        try {
            $key=ConvertTo-SecureString 'SYNTHETIC_H4_DPAPI_ONLY' -AsPlainText -Force
            $key | ConvertFrom-SecureString | Set-Content -LiteralPath $path -Encoding utf8
            $decoded=Read-CreditCredential $path
            $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($decoded)
            try {if([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -ne 'SYNTHETIC_H4_DPAPI_ONLY'){throw 'Roundtrip failed'}}
            finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
            Set-Content -LiteralPath $path -Value 'INVALID_SYNTHETIC_BLOB'
            $refused=$false
            try {$bad=Read-CreditCredential $path; $bad.Dispose()} catch {$refused=$true}
            if(-not $refused){throw 'Corrupt blob accepted'}
            Remove-Item -LiteralPath $path
            $refused=$false
            try {$bad=Read-CreditCredential $path; $bad.Dispose()} catch {$refused=$true}
            if(-not $refused){throw 'Missing blob accepted'}
            Write-Output 'DPAPI_ROUNDTRIP_OK'
        } finally {
            if($key){$key.Dispose()}; if($decoded){$decoded.Dispose()}
            if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}
        }
    `],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/DPAPI_ROUNDTRIP_OK/);
    assert.doesNotMatch(result.stdout,/SYNTHETIC_H4_DPAPI_ONLY/);
});
