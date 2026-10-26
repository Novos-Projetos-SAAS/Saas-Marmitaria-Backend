#Requires -Version 7.2
param([ValidateSet('Prepare','Status','Credential','Backend','Tunnel')][string]$Action='Status',[string]$PublicOrigin)
$ErrorActionPreference='Stop'
$privateRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../infinitepay-credit-private'))
if(-not(Test-Path -LiteralPath $privateRoot)){
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
    & $tunnel tunnel --url http://127.0.0.1:55447 --protocol http2 --no-autoupdate;return
}
if($Action -eq 'Prepare'){
    $pg='C:/Program Files/PostgreSQL/18/bin'
    $exists=& (Join-Path $pg 'psql.exe') -X -h 127.0.0.1 -p 55439 -U codex_test -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='infinitepay_credit_homologacao'"
    if($LASTEXITCODE -ne 0){throw 'PostgreSQL local55439 indisponível.'}
    if($exists -ne '1'){& (Join-Path $pg 'createdb.exe') -h 127.0.0.1 -p 55439 -U codex_test infinitepay_credit_homologacao;if($LASTEXITCODE -ne 0){throw 'Banco exclusivo não criado.'}}
}
$previous=[Environment]::GetEnvironmentVariable('CREDIT_PUBLIC_ORIGIN','Process')
try{
    if($Action -eq 'Backend'){$env:CREDIT_PUBLIC_ORIGIN=$PublicOrigin}
    $command=@{Prepare='prepare';Status='status';Backend='serve'}[$Action]
    & node (Join-Path $PSScriptRoot 'credit/prepare.js') $command
    if($LASTEXITCODE -ne 0){throw 'Preparação de Crédito bloqueada.'}
}finally{[Environment]::SetEnvironmentVariable('CREDIT_PUBLIC_ORIGIN',$previous,'Process')}
