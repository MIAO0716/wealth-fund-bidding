# 一键部署包公共函数（兼容 Windows PowerShell 5.1）
# 程序安装到 C:\ProgramData\BiddingSystem\runtime（纯英文路径，避免数据库在中文路径下出错）
# 数据保存在 C:\ProgramData\BiddingSystem\data（数据库、日志、备份、配置），升级程序不影响数据。

# 注意：Windows PowerShell 5.1 会把外部程序写到 stderr 的内容当作错误记录，
# 因此不用全局 Stop，外部程序一律检查 $LASTEXITCODE，关键 cmdlet 单独加 -ErrorAction Stop。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Script:PackageRuntime = Split-Path -Parent $PSScriptRoot
$Script:InstallRoot = if ($env:BIDDING_HOME) { $env:BIDDING_HOME } else { Join-Path $env:ProgramData 'BiddingSystem' }
$Script:Runtime = Join-Path $InstallRoot 'runtime'
$Script:DataRoot = Join-Path $InstallRoot 'data'
$Script:PgData = Join-Path $DataRoot 'pgdata'
$Script:LogDir = Join-Path $DataRoot 'logs'
$Script:BackupDir = Join-Path $DataRoot 'backups'
$Script:ConfigPath = Join-Path $DataRoot 'config.json'
$Script:NodeExe = Join-Path $Runtime 'node\node.exe'
$Script:PgBin = Join-Path $Runtime 'pgsql\bin'
$Script:AppDir = Join-Path $Runtime 'app'
$Script:DbName = 'bidding'

function Write-Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Yellow }
function Write-Ok([string]$text) { Write-Host "    [完成] $text" -ForegroundColor Green }
function Write-Note([string]$text) { Write-Host "    $text" }
function Write-Warn2([string]$text) { Write-Host "    [注意] $text" -ForegroundColor Magenta }
function Stop-WithError([string]$text) {
  Write-Host ''
  Write-Host "[出错] $text" -ForegroundColor Red
  Write-Host "日志目录：$LogDir"
  exit 1
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PackageVersion([string]$runtimeDir) {
  $f = Join-Path $runtimeDir 'VERSION'
  if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
  return ''
}

# 把压缩包里的程序复制到固定的英文路径；版本相同则跳过
function Install-Runtime {
  $src = (Resolve-Path $PackageRuntime).Path.TrimEnd('\')
  $dst = $Runtime.TrimEnd('\')
  if ($src -ieq $dst) { return }
  $srcVer = Get-PackageVersion $src
  $dstVer = Get-PackageVersion $dst
  if ($srcVer -and $srcVer -eq $dstVer -and (Test-Path $NodeExe)) { return }
  Write-Step "安装程序到 $dst（首次或升级时执行，约 1 分钟）"
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  & robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { Stop-WithError "复制程序失败（robocopy 退出码 $LASTEXITCODE），请确认程序未在运行后重试" }
  # 去掉「来自互联网」标记，避免隐藏窗口中启动数据库时弹出看不见的安全警告
  Get-ChildItem -Path $dst -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  Write-Ok "程序版本 $srcVer"
}

function New-RandomHex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([BitConverter]::ToString($b) -replace '-', '').ToLower()
}

function Get-Config {
  New-Item -ItemType Directory -Force -Path $DataRoot, $LogDir, $BackupDir | Out-Null
  if (Test-Path $ConfigPath) {
    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else {
    $cfg = [pscustomobject]@{
      dbPassword       = (New-RandomHex 24)
      dbPort           = 54329
      appPort          = 8080
      publicBaseUrl    = 'auto'
      lastPublicBaseUrl = ''
    }
    Save-Config $cfg
  }
  return $cfg
}

function Save-Config($cfg) {
  $json = $cfg | ConvertTo-Json
  [IO.File]::WriteAllText($ConfigPath, $json, (New-Object Text.UTF8Encoding($false)))
}

function Invoke-Pg([string]$exe, [string[]]$arguments) {
  $path = Join-Path $PgBin "$exe.exe"
  & $path @arguments
  return $LASTEXITCODE
}

function Test-PgRunning {
  & (Join-Path $PgBin 'pg_ctl.exe') status -D $PgData *> $null
  return ($LASTEXITCODE -eq 0)
}

# 初始化（首次）并启动数据库，只监听本机 127.0.0.1
function Start-Database($cfg) {
  $env:PGPASSWORD = $cfg.dbPassword
  if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) {
    Write-Step '初始化数据库（仅首次）'
    $pw = Join-Path $DataRoot 'pw.tmp'
    [IO.File]::WriteAllText($pw, $cfg.dbPassword, (New-Object Text.UTF8Encoding($false)))
    try {
      & (Join-Path $PgBin 'initdb.exe') -D $PgData -U postgres -A scram-sha-256 "--pwfile=$pw" -E UTF8 --no-locale *> (Join-Path $LogDir 'initdb.log')
      if ($LASTEXITCODE -ne 0) { Stop-WithError "数据库初始化失败，详见 $LogDir\initdb.log" }
    } finally {
      Remove-Item $pw -Force -ErrorAction SilentlyContinue
    }
    Write-Ok '数据库已初始化'
  }
  if (-not (Test-PgRunning)) {
    Write-Step '启动数据库'
    $opts = "-p $($cfg.dbPort) -c listen_addresses=127.0.0.1"
    # 在独立的隐藏窗口中启动：关闭主窗口不会中断数据库；不重定向输出，避免数据库进程继承句柄导致脚本挂起
    $argList = @('start', '-D', "`"$PgData`"", '-l', "`"$(Join-Path $LogDir 'postgres.log')`"", '-o', "`"$opts`"", '-w', '-t', '90')
    $p = Start-Process -FilePath (Join-Path $PgBin 'pg_ctl.exe') -ArgumentList $argList -WindowStyle Hidden -PassThru
    $null = $p.Handle
    $p.WaitForExit()
    if (-not (Test-PgRunning)) { Stop-WithError "数据库启动失败，详见 $LogDir\postgres.log（端口 $($cfg.dbPort) 可能被占用）" }
    Write-Ok "数据库已启动（端口 $($cfg.dbPort)，仅本机访问）"
  }
  $exists = & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'"
  if ($LASTEXITCODE -ne 0) { Stop-WithError '无法连接数据库' }
  if (-not "$exists".Trim()) {
    & (Join-Path $PgBin 'createdb.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres $DbName
    if ($LASTEXITCODE -ne 0) { Stop-WithError '创建业务数据库失败' }
  }
}

function Stop-Database {
  if (Test-Path (Join-Path $PgData 'PG_VERSION')) {
    if (Test-PgRunning) {
      & (Join-Path $PgBin 'pg_ctl.exe') stop -D $PgData -m fast -w -t 60 *> $null
    }
  }
}

function Invoke-Sql($cfg, [string]$sql) {
  $env:PGPASSWORD = $cfg.dbPassword
  $out = & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres -d $DbName -v ON_ERROR_STOP=1 -tAc $sql
  if ($LASTEXITCODE -ne 0) { throw "SQL 执行失败：$sql" }
  return "$out".Trim()
}

# 本机局域网地址：优先有默认网关的已连接网卡
function Get-LanIp {
  try {
    $cfgs = Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' }
    foreach ($c in $cfgs) {
      foreach ($a in @($c.IPv4Address)) {
        if ($a.IPAddress -and $a.IPAddress -notlike '169.254.*') { return $a.IPAddress }
      }
    }
  } catch { }
  try {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' }
    if ($ips) { return @($ips)[0].IPAddress }
  } catch { }
  return $null
}

function Get-PublicBaseUrl($cfg, [int]$port) {
  if ($cfg.publicBaseUrl -and $cfg.publicBaseUrl -ne 'auto') { return $cfg.publicBaseUrl.TrimEnd('/') }
  $ip = Get-LanIp
  if (-not $ip) {
    Write-Warn2 '未检测到局域网地址（电脑可能没有联网），二维码只能在本机打开'
    return "http://localhost:$port"
  }
  return "http://${ip}:$port"
}

function Test-PortFree([int]$port) {
  $l = $null
  try {
    $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any, $port)
    $l.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($l) { $l.Stop() }
  }
}

function Test-OurServer([int]$port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/healthz"
    return ($r.StatusCode -eq 200 -and $r.Content -match '"status"')
  } catch {
    return $false
  }
}

# 放行入站端口，让手机能访问（需要一次管理员授权）
function Grant-Firewall([int]$port) {
  if ($env:BIDDING_NO_FIREWALL) { return }
  $name = "BiddingSystem-$port"
  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($rule) { return }
  Write-Step "放行防火墙端口 $port（手机访问需要；Windows 会弹出一次授权确认）"
  $cmd = "New-NetFirewallRule -DisplayName '$name' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null"
  try {
    if (Test-IsAdmin) {
      Invoke-Expression $cmd
    } else {
      Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command $cmd"
    }
  } catch { }
  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Write-Ok "已放行端口 $port"
  } else {
    Write-Warn2 "未能放行端口 $port：手机可能无法访问。可再次运行启动程序并在弹窗中点「是」，或请电脑管理员放行该端口"
  }
}

function Set-AppEnv($cfg, [int]$port, [string]$publicBaseUrl) {
  $env:DATABASE_URL = "postgres://postgres:$($cfg.dbPassword)@127.0.0.1:$($cfg.dbPort)/$DbName"
  $env:HOST = '0.0.0.0'
  $env:PORT = "$port"
  $env:PUBLIC_BASE_URL = $publicBaseUrl
  $env:WEB_DIST = Join-Path $AppDir 'apps\web\dist'
  $env:MIGRATIONS_DIR = Join-Path $AppDir 'apps\server\migrations'
  $env:BACKUP_DIR = $BackupDir
  $env:PG_DUMP_PATH = Join-Path $PgBin 'pg_dump.exe'
  $env:LOG_LEVEL = 'info'
  $env:NODE_ENV = 'production'
  $env:TRUST_PROXY = 'false'
  $env:READ_ONLY = 'false'
}

function Read-NewPassword([string]$prompt) {
  while ($true) {
    $a = Read-Host -AsSecureString $prompt
    $b = Read-Host -AsSecureString '请再输入一次'
    $pa = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
    $pb = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
    if ($pa -ne $pb) { Write-Warn2 '两次输入不一致，请重新输入'; continue }
    if ($pa.Length -lt 10) { Write-Warn2 '密码至少 10 位，请重新输入'; continue }
    return $pa
  }
}

# 在独立的隐藏窗口中运行 node 脚本并等待，返回退出码。
# node 不与本窗口共用控制台：直接在本窗口运行时，Windows Terminal 会把附近几行中文重复显示（如「检检查查」）。
function Invoke-NodeScript([string]$script, [string[]]$scriptArgs, [string]$logName) {
  $argList = @("`"$(Join-Path $AppDir "apps\server\dist\$script")`"") + @($scriptArgs | ForEach-Object { "`"$_`"" })
  $p = Start-Process -FilePath $NodeExe -ArgumentList $argList -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "$logName.log") -RedirectStandardError (Join-Path $LogDir "$logName.err.log")
  $null = $p.Handle
  $p.WaitForExit()
  return $p.ExitCode
}

function Set-AdminPassword([string]$password) {
  $env:ADMIN_PASSWORD = $password
  try {
    $code = Invoke-NodeScript 'admin-create.js' @('--username', 'admin', '--name', '工作人员') 'admin-create'
    if ($code -ne 0) { Stop-WithError "设置管理员密码失败，详见 $LogDir\admin-create.err.log" }
  } finally {
    Remove-Item Env:\ADMIN_PASSWORD -ErrorAction SilentlyContinue
  }
}

function Stop-AppServer {
  $pattern = [Regex]::Escape((Join-Path $AppDir 'apps\server\dist\main.js'))
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pattern }
  foreach ($p in @($procs)) {
    if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  return @($procs | Where-Object { $_ }).Count
}
