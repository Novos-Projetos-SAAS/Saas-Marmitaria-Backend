#Requires -Version 7.2
param([ValidateSet('Prepare','Postgres','Backend','Frontend','Start','Open','Access','Logs','Status','Stop','TrustCertificate')][string]$Action='Status')
$ErrorActionPreference='Stop'
$backendRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateRoot=[IO.Path]::GetFullPath((Join-Path $backendRoot '../infinitepay-demo-private'))
$profilePath=Join-Path $privateRoot 'profile.json'
$statePath=Join-Path $privateRoot 'processes.json'
$pgBin='C:/Program Files/PostgreSQL/18/bin'
$pgData=[IO.Path]::GetFullPath((Join-Path $backendRoot '../infinitepay-test-cluster'))
$node=(Get-Command node.exe -ErrorAction Stop).Source
function Random-Value([int]$Bytes=32){[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).TrimEnd('=').Replace('+','-').Replace('/','_')}
function Initialize-Profile {
    if(-not(Test-Path -LiteralPath $privateRoot)){
        New-Item -ItemType Directory -Path $privateRoot | Out-Null
        $acl=Get-Acl -LiteralPath $privateRoot;$acl.SetAccessRuleProtection($true,$false)
        foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')){
            $identity=[Security.Principal.SecurityIdentifier]::new($sid)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        }
        Set-Acl -LiteralPath $privateRoot -AclObject $acl
    }
    $acl=Get-Acl -LiteralPath $privateRoot
    $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
    if(-not $acl.AreAccessRulesProtected){throw 'Perfil privado precisa de ACL protegida.'}
    foreach($entry in $acl.Access){if($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Perfil privado permite outros usuários.'}}
    if(-not(Test-Path -LiteralPath $profilePath)){
        @{purpose='INFINITEPAY_LOCAL_SIMULATION_ONLY';operatorToken=(Random-Value);adminPassword=('Demo-'+(Random-Value 18));jwtSecret=(Random-Value);encryptionKey=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))} |
            ConvertTo-Json | Set-Content -LiteralPath $profilePath -Encoding utf8
    }
    $script:profile=Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    if($profile.purpose -ne 'INFINITEPAY_LOCAL_SIMULATION_ONLY'){throw 'Finalidade do perfil recusada.'}
    if(-not(Test-Path -LiteralPath (Join-Path $privateRoot 'localhost.pem'))){
        $openssl='C:/Program Files/Git/usr/bin/openssl.exe'
        if(-not(Test-Path -LiteralPath $openssl)){throw 'OpenSSL do Git ausente. Nenhum certificado QZ será utilizado.'}
        & $openssl req -x509 -newkey rsa:2048 -nodes -keyout (Join-Path $privateRoot 'localhost-key.pem') -out (Join-Path $privateRoot 'localhost.pem') -days 365 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2> (Join-Path $privateRoot 'certificate-generation.log')
        if($LASTEXITCODE -ne 0){throw 'Falha ao gerar certificado exclusivamente local.'}
    }
    $env:NODE_EXTRA_CA_CERTS=Join-Path $privateRoot 'localhost.pem'
}
function Read-State {
    if(Test-Path -LiteralPath $statePath){$script:state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json}else{$script:state=[pscustomobject]@{}}
}
function Save-Process([string]$Name,$Process){
    $record=@{pid=$Process.Id;started=$Process.StartTime.ToUniversalTime().ToString('o')}
    $state|Add-Member -NotePropertyName $Name -NotePropertyValue $record -Force
    $state|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $statePath -Encoding utf8
}
function Managed-Process([string]$Name){
    $record=$state.PSObject.Properties[$Name].Value;if(-not $record){return $null}
    $process=Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if(-not $process){return $null}
    $details=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$record.pid)
    $expected=Join-Path $PSScriptRoot ('demo/'+$(if($Name -eq 'backend'){'server.js'}else{'frontend.js'}))
    if($process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.started).ToUniversalTime().Ticks -or
        [IO.Path]::GetFullPath($details.ExecutablePath) -ne [IO.Path]::GetFullPath($node) -or -not $details.CommandLine.Contains($expected)){
        throw 'PID reutilizado ou processo não reconhecido; não será encerrado.'
    }
    return $process
}
function Start-Postgres {
    if(-not(Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))){throw 'Cluster de testes existente não encontrado. Não será criado outro banco.'}
    & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status 2>$null
    if($LASTEXITCODE -ne 0){& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $privateRoot 'postgres.log') -o '-h 127.0.0.1 -p 55439' -w start;if($LASTEXITCODE -ne 0){throw 'PostgreSQL de testes indisponível.'}}
    & (Join-Path $pgBin 'pg_isready.exe') -h 127.0.0.1 -p 55439 -d infinitepay_phase1_test -U codex_test
    if($LASTEXITCODE -ne 0){throw 'Banco de testes55439 indisponível.'}
}
function Prepare-Demo {
    Start-Postgres
    Push-Location $backendRoot
    try{& $node (Join-Path $PSScriptRoot 'demo/prepare.js');if($LASTEXITCODE -ne 0){throw 'Preparação da demonstração falhou.'}}finally{Pop-Location}
}
function Start-Component([string]$Name){
    if(Managed-Process $Name){Write-Output "$Name já está ativo.";return}
    $port=if($Name -eq 'backend'){55446}else{55445}
    if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw "Porta $port ocupada. Nenhum processo alheio será encerrado."}
    $entry=Join-Path $PSScriptRoot ('demo/'+$(if($Name -eq 'backend'){'server.js'}else{'frontend.js'}))
    $process=Start-Process -FilePath $node -ArgumentList @(('"'+$entry+'"')) -WorkingDirectory $backendRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateRoot "$Name.log") -RedirectStandardError (Join-Path $privateRoot "$Name-error.log")
    Save-Process $Name $process
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while(-not(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)){
        $process.Refresh();if($process.HasExited){throw "$Name encerrou durante a inicialização; consulte Logs."}
        if([DateTime]::UtcNow -gt $deadline){throw "$Name ainda não abriu a porta; consulte Status e Logs."}
        Start-Sleep -Milliseconds 200
    }
    Write-Output "$Name iniciado; PID $($process.Id)."
}
Initialize-Profile;Read-State
switch($Action){
    'Postgres'{Start-Postgres}
    'Prepare'{Prepare-Demo}
    'Backend'{Prepare-Demo;Start-Component 'backend'}
    'Frontend'{Start-Component 'frontend'}
    'Start'{Prepare-Demo;Start-Component 'backend';Start-Component 'frontend';Write-Output 'Loja: https://localhost:55445/pedido | Administração: https://localhost:55445/auth/login | Controle: https://localhost:55446/__demo'}
    'Open'{Start-Process 'https://localhost:55445/pedido'}
    'Access'{Write-Output 'Somente demonstração local. Não reutilize esta senha.';Write-Output 'E-mail: admin@demo.invalid';Write-Output ('Senha: '+$profile.adminPassword)}
    'Logs'{
        foreach($name in @('backend.log','backend-error.log','frontend.log','frontend-error.log')){
            Write-Output $name
            if(Test-Path -LiteralPath (Join-Path $privateRoot $name)){
                $lines=Get-Content -LiteralPath (Join-Path $privateRoot $name) -Tail 25
                foreach($line in $lines){$safe=$line;foreach($secret in @($profile.adminPassword,$profile.operatorToken,$profile.jwtSecret,$profile.encryptionKey)){$safe=$safe.Replace($secret,'[REDACTED]')};Write-Output $safe}
            }
        }
    }
    'Status'{
        foreach($name in @('backend','frontend')){$process=Managed-Process $name;Write-Output ($name+': '+$(if($process){'ativo, PID '+$process.Id}else{'parado'}))}
        if(Managed-Process 'backend'){& $node (Join-Path $PSScriptRoot 'demo/environment.js') status;if($LASTEXITCODE -ne 0){throw 'Saúde da demonstração não confirmada.'}}
    }
    'Stop'{
        if(Managed-Process 'backend'){
            & $node (Join-Path $PSScriptRoot 'demo/environment.js') stop|Out-Null
            if($LASTEXITCODE -ne 0){throw 'Encerramento recusado ou certificado inválido.'}
            $deadline=[DateTime]::UtcNow.AddSeconds(35)
            while((Managed-Process 'backend') -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
            if(Managed-Process 'backend'){throw 'Backend ainda drenando. Consulte Status; não foi encerrado à força.'}
        }
        $frontend=Managed-Process 'frontend';if($frontend){& taskkill.exe /PID $frontend.Id /T /F|Out-Null;if($LASTEXITCODE -ne 0){throw 'Não foi possível encerrar somente o Frontend da demonstração.'}}
        Write-Output 'Serviços de demonstração encerrados. PostgreSQL compartilhado e dados persistentes preservados.'
    }
    'TrustCertificate'{
        $certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile((Join-Path $privateRoot 'localhost.pem'))
        Write-Output ('Certificado exclusivamente localhost: '+$certificate.Thumbprint)
        if((Read-Host 'Digite CONFIAR LOCALHOST para confiar neste certificado somente no usuário Windows atual') -ne 'CONFIAR LOCALHOST'){throw 'Confiança não alterada.'}
        $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
        try{$store.Open('ReadWrite');$store.Add($certificate)}finally{$store.Close()}
        Write-Output 'Certificado local adicionado ao usuário atual. Nenhum certificado QZ foi alterado.'
    }
}
