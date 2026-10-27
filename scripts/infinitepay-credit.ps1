#Requires -Version 7.2
param([ValidateSet('Prepare','Status','Diagnose','AuthorizeCreateLink','Credential','Backend','Tunnel','Preflight','CreateLink','ViewCheckout','Events','CheckEvidence','CheckPayment','CheckResult','Reconcile','Deliver','StopBackend')][string]$Action='Status',[string]$PublicOrigin,[int]$AmountCentavos=0)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'credit/credential.ps1')
$privateRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../infinitepay-credit-private'))
if(-not(Test-Path -LiteralPath $privateRoot)){
    if($Action -in @('Diagnose','AuthorizeCreateLink')){throw 'Perfil privado H4 ausente. Nenhum arquivo criado.'}
    New-Item -ItemType Directory -Path $privateRoot|Out-Null
    $acl=Get-Acl -LiteralPath $privateRoot;$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')){
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    Set-Acl -LiteralPath $privateRoot -AclObject $acl
}
$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18');$acl=Get-Acl -LiteralPath $privateRoot
if(-not $acl.AreAccessRulesProtected){throw 'ACL privada obrigatória.'}
foreach($entry in $acl.Access){if($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'ACL permite outros usuários.'}}
$profilePath=Join-Path $privateRoot 'profile.json'
$node=(Get-Command node.exe -ErrorAction Stop).Source
$nodeScript=Join-Path $PSScriptRoot 'credit/prepare.js'
function Read-Owned([string]$File,[string]$Executable,[string]$Needle){
    $path=Join-Path $privateRoot $File;if(-not(Test-Path -LiteralPath $path)){return $null}
    $record=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
    $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue;if(-not $process){return $null}
    $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.pid)
    if($process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.started).ToUniversalTime().Ticks -or
        [IO.Path]::GetFullPath($details.ExecutablePath) -ne [IO.Path]::GetFullPath($Executable) -or -not $details.CommandLine.Contains($Needle)){throw 'Processo reutilizado ou não reconhecido.'}
    return $process
}
function Invoke-CreditNode([string]$Command,[switch]$GateOnly){
    $names=@('NODE_ENV','INFINITEPAY_CHECKOUT_ENABLED','DATABASE_URL','TEST_DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGOPTIONS',
        'INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEY_VERSION','NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE','DEBUG','CREDIT_API_KEY','CREDIT_AMOUNT_CENTAVOS',
        'CREDIT_DPAPI_STATUS','CREDIT_CREDENTIAL_SHA256','CREDIT_BACKEND_STATUS','CREDIT_TUNNEL_STATUS')
    $previous=@{};$pointer=[IntPtr]::Zero;$secureKey=$null
    try{
        foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$null,'Process')}
        $env:NODE_ENV='development';$env:INFINITEPAY_CHECKOUT_ENABLED='false';$env:CREDIT_AMOUNT_CENTAVOS=[string]$AmountCentavos
        if($Command -in @('create','check') -and -not $GateOnly){
            $path=Join-Path $privateRoot 'api-key.dpapi';if(-not(Test-Path -LiteralPath $path)){throw 'Configure a credencial por Credential, sem enviar pelo chat.'}
            $secureKey=Read-CreditCredential $path
            $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
            $env:CREDIT_API_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        }
        if($Command -in @('diagnose','authorize')){
            $path=Join-Path $privateRoot 'api-key.dpapi';$env:CREDIT_DPAPI_STATUS='MISSING'
            if(Test-Path -LiteralPath $path){
                try{
                    $secureKey=Read-CreditCredential $path
                    $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
                    $keyBytes=[Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
                    try{
                        if(-not $keyBytes.Length -or $keyBytes.Length -gt 4096 -or @($keyBytes|Where-Object {$_ -lt 33 -or $_ -gt 126}).Count){throw 'Formato da credencial inválido.'}
                        $env:CREDIT_CREDENTIAL_SHA256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($keyBytes)).ToLowerInvariant()
                        $env:CREDIT_DPAPI_STATUS='VALID'
                    }finally{[Array]::Clear($keyBytes,0,$keyBytes.Length)}
                }catch{$env:CREDIT_DPAPI_STATUS='INVALID';$env:CREDIT_CREDENTIAL_SHA256=$null}
            }
            foreach($component in @('backend','tunnel')){
                $state='INVALID'
                try{
                    $executable=if($component -eq 'backend'){$node}else{Join-Path $privateRoot 'cloudflared.exe'}
                    $needle=if($component -eq 'backend'){$nodeScript}else{'127.0.0.1:55447'}
                    $owned=Read-Owned ($component+'-process.json') $executable $needle
                    if($owned){
                        if($component -eq 'backend'){
                            $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 55447 -ErrorAction SilentlyContinue)
                            if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne $owned.Id){throw 'Listener divergente.'}
                            $record=Get-Content -LiteralPath (Join-Path $privateRoot 'backend-process.json') -Raw|ConvertFrom-Json
                        }else{$record=Get-Content -LiteralPath (Join-Path $privateRoot 'tunnel-process.json') -Raw|ConvertFrom-Json}
                        $endpoints=Get-Content -LiteralPath (Join-Path $privateRoot 'endpoints.json') -Raw|ConvertFrom-Json
                        if($component -eq 'backend' -and $record.publicOrigin -ne $endpoints.origin){throw 'Origem divergente.'}
                        if($component -eq 'tunnel' -and ($endpoints.pid -ne $owned.Id -or $endpoints.executable -ne $executable -or ([datetime]$endpoints.started).ToUniversalTime().Ticks -ne $owned.StartTime.ToUniversalTime().Ticks)){throw 'Túnel divergente.'}
                        $state='VALID'
                    }
                }catch{}
                [Environment]::SetEnvironmentVariable(('CREDIT_'+$component.ToUpperInvariant()+'_STATUS'),$state,'Process')
            }
            $entry=if($Command -eq 'diagnose'){'credit/diagnose.js'}else{'credit/authorize.js'}
            & $node (Join-Path $PSScriptRoot $entry)
        }elseif($GateOnly){& $node $nodeScript $Command --gate-only}else{& $node $nodeScript $Command}
        if($LASTEXITCODE -ne 0){throw 'H4 bloqueada; nenhuma retentativa automática será feita.'}
    }finally{
        if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
        if($secureKey){$secureKey.Dispose()}
        foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}
    }
}
if($Action -eq 'Diagnose'){Invoke-CreditNode 'diagnose';return}
if($Action -eq 'AuthorizeCreateLink'){
    if($AmountCentavos -ne 100){throw 'Esta autorização H4 é exclusiva para BRL 100 centavos; nenhum valor alternativo.'}
    Invoke-CreditNode 'authorize';return
}
if(-not(Test-Path -LiteralPath $profilePath)){
    @{purpose='INFINITEPAY_CREDIT_PREPARATION_ONLY';host='127.0.0.1';port=55439;database='infinitepay_credit_homologacao';user='codex_test';checkoutEnabled=$false;
        encryptionKey=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))}|ConvertTo-Json|Set-Content -LiteralPath $profilePath -Encoding utf8
}
if($Action -eq 'Credential'){
    $path=Join-Path $privateRoot 'api-key.dpapi';if(Test-Path -LiteralPath $path){Write-Output 'Credencial já protegida; sem substituição.';return}
    $key=Read-Host 'API Key exclusiva de Crédito (armazenar, sem utilizar)' -AsSecureString
    try{if(-not $key.Length){throw 'Chave vazia.'};$key|ConvertFrom-SecureString|Set-Content -LiteralPath $path -Encoding utf8}finally{$key.Dispose()}
    Write-Output 'Credencial DPAPI protegida. Não carregada pelo servidor de preparação.';return
}
if($Action -eq 'Tunnel'){
    $tunnel=Join-Path $privateRoot 'cloudflared.exe'
    if(-not(Test-Path -LiteralPath $tunnel)){throw 'Executável portátil oficial cloudflared ausente no perfil Crédito. Não reutilize H1.'}
    $running=Read-Owned 'tunnel-process.json' $tunnel '127.0.0.1:55447'
    if($running){
        $record=Get-Content -LiteralPath (Join-Path $privateRoot 'tunnel-process.json') -Raw|ConvertFrom-Json
        $log=if($record.log){$record.log}else{Join-Path $privateRoot 'tunnel.stderr.log'}
    }else{
        Invoke-CreditNode 'can-reconfigure'|Out-Null
        $listening=Get-NetTCPConnection -State Listen -LocalPort 55447 -ErrorAction SilentlyContinue
        if($listening -and -not(Read-Owned 'backend-process.json' $node $nodeScript)){throw 'Porta ocupada por serviço não reconhecido.'}
        $stamp=Get-Date -Format yyyyMMddHHmmssfff;$log=Join-Path $privateRoot ('tunnel-'+$stamp+'.stderr.log')
        $running=Start-Process -FilePath $tunnel -ArgumentList @('tunnel','--url','http://127.0.0.1:55447','--protocol','http2','--no-autoupdate') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateRoot ('tunnel-'+$stamp+'.stdout.log')) -RedirectStandardError $log
        @{pid=$running.Id;started=$running.StartTime.ToUniversalTime().ToString('o');executable=$tunnel;log=$log}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $privateRoot 'tunnel-process.json')
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(25);$origin=$null
    do{
        if($running.HasExited){throw 'Túnel encerrado; não criar cobrança.'}
        $text=Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
        if($text -match 'https://[a-z0-9-]+\.trycloudflare\.com'){$origin=$Matches[0];break}
        Start-Sleep -Milliseconds 200
    }while([DateTime]::UtcNow -lt $deadline)
    if(-not $origin){throw 'Origem efetiva não descoberta. Nenhuma URL será presumida.'}
    $endpointFile=Join-Path $privateRoot 'endpoints.json';$old=$null
    if(Test-Path -LiteralPath $endpointFile){$old=Get-Content -LiteralPath $endpointFile -Raw|ConvertFrom-Json}
    if(-not $old -or $old.origin -ne $origin -or $old.pid -ne $running.Id){Invoke-CreditNode 'can-reconfigure'|Out-Null}
    @{origin=$origin;pid=$running.Id;executable=$tunnel;started=$running.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $endpointFile
    Write-Output ('HTTPS Crédito: '+$origin+' | PID '+$running.Id);return
}
if($Action -eq 'StopBackend'){
    $process=Read-Owned 'backend-process.json' $node $nodeScript;if($process){Stop-Process -Id $process.Id}
    Write-Output 'Somente o Backend Crédito foi encerrado; túnel, banco e registros preservados.';return
}
if($Action -eq 'Backend'){
    $endpointFile=Join-Path $privateRoot 'endpoints.json';if(-not(Test-Path -LiteralPath $endpointFile)){throw 'Execute Tunnel para conferir a origem vigente.'}
    $endpoints=Get-Content -LiteralPath $endpointFile -Raw|ConvertFrom-Json
    if($PublicOrigin -and $PublicOrigin -ne $endpoints.origin){throw 'Origem informada diverge do túnel identificado.'}
    if(-not(Read-Owned 'tunnel-process.json' (Join-Path $privateRoot 'cloudflared.exe') '127.0.0.1:55447')){throw 'Túnel identificado indisponível.'}
    $running=Read-Owned 'backend-process.json' $node $nodeScript
    if($running){Write-Output ('Backend Crédito já ativo, PID '+$running.Id);return}
    if(Get-NetTCPConnection -State Listen -LocalPort 55447 -ErrorAction SilentlyContinue){throw 'Porta55447 ocupada.'}
    $names=@('NODE_ENV','INFINITEPAY_CHECKOUT_ENABLED','CREDIT_API_KEY','INFINITEPAY_ENCRYPTION_KEYS','INFINITEPAY_ENCRYPTION_KEY','INFINITEPAY_ENCRYPTION_KEY_VERSION',
        'NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE','DEBUG','DATABASE_URL','TEST_DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGOPTIONS')
    $previous=@{}
    try{
        foreach($name in $names){$previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$null,'Process')}
        $env:NODE_ENV='development';$env:INFINITEPAY_CHECKOUT_ENABLED='false'
        $stamp=Get-Date -Format yyyyMMddHHmmssfff
        $process=Start-Process -FilePath $node -ArgumentList @('"'+$nodeScript+'"','serve') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateRoot ('backend-'+$stamp+'.log')) -RedirectStandardError (Join-Path $privateRoot ('backend-'+$stamp+'.error.log'))
        @{pid=$process.Id;started=$process.StartTime.ToUniversalTime().ToString('o');script=$nodeScript;publicOrigin=$endpoints.origin}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $privateRoot 'backend-process.json')
        Write-Output ('Backend Crédito iniciado, PID '+$process.Id+'. Execute Preflight para validar.');return
    }finally{foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')}}
}
if($Action -eq 'Prepare'){
    $pg='C:/Program Files/PostgreSQL/18/bin'
    $exists=& (Join-Path $pg 'psql.exe') -X -h 127.0.0.1 -p 55439 -U codex_test -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='infinitepay_credit_homologacao'"
    if($LASTEXITCODE -ne 0){throw 'PostgreSQL local55439 indisponível.'}
    if($exists -ne '1'){& (Join-Path $pg 'createdb.exe') -h 127.0.0.1 -p 55439 -U codex_test infinitepay_credit_homologacao;if($LASTEXITCODE -ne 0){throw 'Banco exclusivo não criado.'}}
}
$command=@{Prepare='prepare';Status='status';Preflight='preflight';CreateLink='create';ViewCheckout='checkout';Events='events';CheckEvidence='evidence';CheckPayment='check';CheckResult='check-result';Reconcile='reconcile';Deliver='deliver'}[$Action]
if($Action -in @('CreateLink','CheckPayment','Reconcile','Deliver')){
    if($AmountCentavos -lt 1){throw 'Informe o valor previamente autorizado em AmountCentavos.'}
    Invoke-CreditNode $command -GateOnly
}
Invoke-CreditNode $command
if($Action -eq 'Status'){Write-Output ('Credencial DPAPI protegida presente: '+(Test-Path -LiteralPath (Join-Path $privateRoot 'api-key.dpapi')))}
