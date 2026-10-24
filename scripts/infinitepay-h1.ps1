param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Postgres', 'Backend', 'Tunnel', 'Verify', 'Status', 'Credential', 'Stop', 'CreateLink', 'Result')]
    [string]$Action
)
$ErrorActionPreference = 'Stop'
$privateDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../infinitepay-h1-private'))
$statePath = Join-Path $privateDirectory 'state.json'
$pgBin = 'C:/Program Files/PostgreSQL/18/bin'
$pgData = Join-Path $privateDirectory 'pgdata'
$nodeScript = Join-Path $PSScriptRoot 'infinitepay-h1.js'
$cloudflared = Join-Path $privateDirectory 'bin/cloudflared.exe'
$settings = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if ($settings.purpose -ne 'INFINITEPAY_H1_ONLY' -or $settings.host -ne '127.0.0.1' -or $settings.port -ne 55440 -or
    $settings.database -ne 'infinitepay_h1_homologacao' -or $settings.user -ne 'codex_h1_owner' -or
    $settings.approved_amount_centavos -ne 100 -or $settings.approved_max_real_link_creations -ne 1) { throw 'Configuração H1 recusada.' }
$acl = Get-Acl -LiteralPath $privateDirectory
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $acl.AreAccessRulesProtected) { throw 'O diretório privado deve ter ACL protegida.' }
foreach ($entry in $acl.Access) {
    $entrySid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($entry.AccessControlType -eq 'Allow' -and $entrySid -notin @($currentSid, 'S-1-5-18')) { throw 'ACL H1 permite outro usuário; revise antes de continuar.' }
}
function Set-H1Property([string]$Name, $Value) {
    $script:settings | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
    $script:settings | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $script:statePath -Encoding UTF8
}
function Get-ManagedProcess([string]$Field, [string]$ExpectedPath) {
    $property = $settings.PSObject.Properties[$Field]
    if (-not $property) { return $null }
    $taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$property.Value) -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskProcess.ExecutablePath -and [IO.Path]::GetFullPath($taskProcess.ExecutablePath) -eq [IO.Path]::GetFullPath($ExpectedPath)) { return $taskProcess }
    return $null
}
function Resolve-H1TunnelOrigin($TunnelProcess, [string]$LogPath, [int]$TimeoutMilliseconds = 20000) {
    try {
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
        do {
            if ($TunnelProcess.HasExited) { throw 'Túnel encerrado antes da descoberta de HTTPS.' }
            $text = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
            if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') { return $Matches[0] }
            Start-Sleep -Milliseconds ([Math]::Min(200, $TimeoutMilliseconds))
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'URL HTTPS ainda indisponível.'
    } catch {
        try { if (-not $TunnelProcess.HasExited) { $TunnelProcess.Kill() } } finally {
            $script:settings | Add-Member -NotePropertyName tunnel_pid -NotePropertyValue $null -Force
            $script:settings | Add-Member -NotePropertyName tunnel_origin_pid -NotePropertyValue $null -Force
            Set-H1Property 'public_origin' $null
        }
        throw 'Falha ao descobrir o HTTPS: túnel encerrado e origem antiga invalidada. Nenhum link deve ser criado.'
    }
}
switch ($Action) {
    'Postgres' {
        & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status 2>$null
        if ($LASTEXITCODE -ne 0) {
            & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $privateDirectory 'postgres.log') -o '-h 127.0.0.1 -p 55440' -w start
            if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar o PostgreSQL H1 existente.' }
        }
        return
    }
    'Credential' {
        $credentialPath = Join-Path $privateDirectory 'api-key.dpapi'
        if (Test-Path -LiteralPath $credentialPath) { Write-Output 'A API Key local protegida já está configurada; nenhuma substituição realizada.'; return }
        $secureKey = Read-Host 'API Key InfinitePay H1 (não será exibida)' -AsSecureString
        if ($secureKey.Length -eq 0) { throw 'API Key vazia; nada gravado.' }
        $secureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $credentialPath -Encoding UTF8
        $secureKey.Dispose()
        Write-Output 'API Key protegida por DPAPI e ACL local. Não foi utilizada nem enviada.'
        return
    }
    'Tunnel' {
        if (-not (Test-Path -LiteralPath $cloudflared)) { throw 'cloudflared portátil ausente no diretório privado H1.' }
        $runningTunnel = Get-ManagedProcess 'tunnel_pid' $cloudflared
        if ($runningTunnel) {
            if ($settings.PSObject.Properties['tunnel_origin_pid'] -and $settings.tunnel_origin_pid -eq $runningTunnel.ProcessId -and
                $settings.public_origin -match '^https://[a-z0-9-]+\.trycloudflare\.com$') {
                Write-Output ('Túnel existente: ' + $settings.public_origin); return
            }
            $tunnelProcess = [Diagnostics.Process]::GetProcessById($runningTunnel.ProcessId)
            $logPath = if ($settings.PSObject.Properties['tunnel_stderr']) { $settings.tunnel_stderr } else { Join-Path $privateDirectory 'tunnel.stderr.log' }
            $resolvedOrigin = Resolve-H1TunnelOrigin $tunnelProcess $logPath
            Set-H1Property 'tunnel_origin_pid' $tunnelProcess.Id
            Set-H1Property 'public_origin' $resolvedOrigin
            Write-Output ('Túnel recuperado: ' + $resolvedOrigin); return
        }
        if (Get-ManagedProcess 'backend_pid' (Get-Command node.exe).Source) { throw 'Pare o backend H1 antes de trocar a URL do túnel.' }
        $stdout = Join-Path $privateDirectory 'tunnel.stdout.log'
        $stderr = Join-Path $privateDirectory 'tunnel.stderr.log'
        if ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr)) {
            $stamp = Get-Date -Format 'yyyyMMddHHmmssfff'
            $stdout = Join-Path $privateDirectory ('tunnel-' + $stamp + '.stdout.log')
            $stderr = Join-Path $privateDirectory ('tunnel-' + $stamp + '.stderr.log')
        }
        Set-H1Property 'public_origin' $null
        Set-H1Property 'tunnel_origin_pid' $null
        Set-H1Property 'tunnel_stderr' $stderr
        $tunnelProcess = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:55441', '--protocol', 'http2', '--no-autoupdate') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Set-H1Property 'tunnel_pid' $tunnelProcess.Id
        $resolvedOrigin = Resolve-H1TunnelOrigin $tunnelProcess $stderr
        Set-H1Property 'tunnel_origin_pid' $tunnelProcess.Id
        Set-H1Property 'public_origin' $resolvedOrigin
        Write-Output ('Webhook: ' + $settings.public_origin + '/pagamentos/infinitepay/webhook')
        Write-Output ('Retorno: ' + $settings.public_origin + '/pagamentos/infinitepay/retorno')
        return
    }
    'Stop' {
        $nodeExe = (Get-Command node.exe).Source
        $backendProcess = Get-ManagedProcess 'backend_pid' $nodeExe
        if ($backendProcess -and $backendProcess.CommandLine -like '*infinitepay-h1.js*serve*') { Stop-Process -Id $backendProcess.ProcessId }
        $tunnelProcess = Get-ManagedProcess 'tunnel_pid' $cloudflared
        if ($tunnelProcess -and $tunnelProcess.CommandLine -like '*127.0.0.1:55441*') { Stop-Process -Id $tunnelProcess.ProcessId }
        Write-Output 'Processos HTTP e túnel H1 encerrados; PostgreSQL e registros preservados.'
        return
    }
}
$nodeAction = @{ Backend = 'serve'; Verify = 'verify'; Status = 'status'; CreateLink = 'create-link'; Result = 'result' }[$Action]
if ($Action -eq 'Backend' -and (Get-ManagedProcess 'backend_pid' (Get-Command node.exe).Source)) { throw 'O backend H1 já está em execução.' }
$variables = @('NODE_ENV', 'INFINITEPAY_CHECKOUT_ENABLED', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'TEST_DATABASE_URL',
    'H1_SETTINGS_FILE', 'H1_DB_PASSWORD', 'H1_OBSERVATION_KEY', 'H1_API_KEY', 'INFINITEPAY_ENCRYPTION_KEY', 'INFINITEPAY_ENCRYPTION_KEYS',
    'INFINITEPAY_ENCRYPTION_KEY_VERSION', 'NODE_OPTIONS', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'DEBUG')
$previous = @{}
try {
    foreach ($variable in $variables) { $previous[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process'); [Environment]::SetEnvironmentVariable($variable, $null, 'Process') }
    $env:NODE_ENV = 'development'
    $env:INFINITEPAY_CHECKOUT_ENABLED = 'false'
    $env:H1_SETTINGS_FILE = $statePath
    $env:H1_DB_PASSWORD = [Net.NetworkCredential]::new('', (ConvertTo-SecureString $settings.db_password_dpapi)).Password
    $env:H1_OBSERVATION_KEY = [Net.NetworkCredential]::new('', (ConvertTo-SecureString $settings.encryption_key_dpapi)).Password
    if ($Action -eq 'CreateLink') {
        $credentialPath = Join-Path $privateDirectory 'api-key.dpapi'
        if (-not (Test-Path -LiteralPath $credentialPath)) {
            throw 'Configure a API Key com -Action Credential antes de criar o link.'
        } else {
            $env:H1_API_KEY = [Net.NetworkCredential]::new('', (ConvertTo-SecureString (Get-Content -LiteralPath $credentialPath -Raw).Trim())).Password
        }
    }
    & node.exe $nodeScript $nodeAction
    if ($LASTEXITCODE -ne 0) { throw 'Operação H1 interrompida. Consulte -Action Result; não repita uma criação financeira.' }
    if ($Action -eq 'Status') { Write-Output ('API Key provisionada: ' + (Test-Path -LiteralPath (Join-Path $privateDirectory 'api-key.dpapi'))) }
} finally {
    foreach ($variable in $variables) { [Environment]::SetEnvironmentVariable($variable, $previous[$variable], 'Process') }
}
