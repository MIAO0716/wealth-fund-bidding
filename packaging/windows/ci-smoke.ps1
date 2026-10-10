# 在 Windows 构建机上验证一键部署包：解压到「中文 + 空格」路径，通过 .bat 启动/停止/备份/恢复，并做端到端检查
param([string]$Zip = 'dist-package\BiddingSystem-windows-x64.zip')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Zip = (Resolve-Path (Join-Path $repo $Zip)).Path
$dest = Join-Path $env:RUNNER_TEMP '测试 目录'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
& 7z x $Zip "-o$dest" -y | Out-Null
$pkg = Join-Path $dest 'BiddingSystem'
Get-ChildItem $pkg | ForEach-Object { Write-Host "  包内：$($_.Name)" }
foreach ($n in @('1-启动系统.bat', '2-停止系统.bat', '3-备份数据.bat', '4-恢复数据.bat', '5-重置管理员密码.bat', '使用说明.txt')) {
  if (-not (Test-Path (Join-Path $pkg $n))) { throw "缺少 $n（中文文件名解压异常？）" }
}

$env:BIDDING_ADMIN_PASSWORD = 'ci-smoke-password-123'
$env:BIDDING_NO_BROWSER = '1'
$env:BIDDING_NO_EXPLORER = '1'
$env:BIDDING_NO_PAUSE = '1'
$env:ADMIN_PASSWORD = $env:BIDDING_ADMIN_PASSWORD
$env:STATE_FILE = Join-Path $env:RUNNER_TEMP 'smoke-state.json'
$data = Join-Path $env:ProgramData 'BiddingSystem\data'

function Start-Package([string]$label) {
  Write-Host "==> 启动（$label）"
  $log = Join-Path $env:RUNNER_TEMP "start-$label.log"
  $p = Start-Process cmd.exe -ArgumentList "/c `"`"$pkg\1-启动系统.bat`" > `"$log`" 2>&1`"" -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 240; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8080/healthz'
      if ($r.StatusCode -eq 200) { Write-Host "服务已启动（$label，$i 秒）"; return $p }
    } catch { }
    if ($p.HasExited) { break }
    Start-Sleep -Seconds 1
  }
  Write-Host (Get-Content $log -Raw -ErrorAction SilentlyContinue)
  Show-Logs
  throw "服务未能启动（$label）"
}

function Invoke-Bat([string]$name, [string]$arg = '', [int]$timeoutSec = 300) {
  $log = Join-Path $env:RUNNER_TEMP "$name.log"
  $argStr = if ($arg) { " `"$arg`"" } else { '' }
  Write-Host "==> 运行 $name"
  # 不用 -Wait：它会等待整个进程树，而数据库本来就应在后台继续运行
  $p = Start-Process cmd.exe -ArgumentList "/c `"`"$pkg\$name`"$argStr > `"$log`" 2>&1`"" -PassThru -WindowStyle Hidden
  $null = $p.Handle
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    Write-Host (Get-Content $log -Raw -ErrorAction SilentlyContinue)
    Show-Logs
    throw "$name 超时（$timeoutSec 秒）"
  }
  Write-Host (Get-Content $log -Raw -ErrorAction SilentlyContinue)
}

function Show-Logs {
  Get-ChildItem (Join-Path $data 'logs') -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "---- $($_.Name)"; Get-Content $_.FullName -Tail 40 }
}

function Test-Down {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8080/healthz' | Out-Null; return $false } catch { return $true }
}

# 1. 首次启动：安装、初始化数据库、创建管理员、放行防火墙
$null = Start-Package 'first'
if (-not (Get-NetFirewallRule -DisplayName 'BiddingSystem-8080' -ErrorAction SilentlyContinue)) { throw '防火墙规则未创建' }
Write-Host '==> 冒烟测试 setup'
& node (Join-Path $repo 'tests\package\smoke.mjs') setup
if ($LASTEXITCODE -ne 0) { throw '冒烟测试失败' }

# 2. 再次双击：检测到已在运行
Invoke-Bat '1-启动系统.bat'

# 3. 备份
Invoke-Bat '3-备份数据.bat'
$backup = Get-ChildItem (Join-Path $data 'backups') -Filter 'manual-*.dump' | Select-Object -First 1
if (-not $backup) { throw '未生成手动备份' }

# 4. 停止 → 重启 → 数据保留
Invoke-Bat '2-停止系统.bat'
Start-Sleep -Seconds 2
if (-not (Test-Down)) { throw '停止后服务仍在运行' }
$null = Start-Package 'restart'
& node (Join-Path $repo 'tests\package\smoke.mjs') verify
if ($LASTEXITCODE -ne 0) { throw '重启后数据校验失败' }

# 5. 恢复（拖放参数方式）
$env:BIDDING_CONFIRM = 'RESTORE'
Invoke-Bat '4-恢复数据.bat' $backup.FullName
if (-not (Test-Down)) { throw '恢复时应先停止服务' }
$null = Start-Package 'after-restore'
& node (Join-Path $repo 'tests\package\smoke.mjs') verify
if ($LASTEXITCODE -ne 0) { throw '恢复后数据校验失败' }

# 6. 重置管理员密码
Invoke-Bat '2-停止系统.bat'
$env:BIDDING_ADMIN_PASSWORD = 'ci-new-password-456'
Invoke-Bat '5-重置管理员密码.bat'
$null = Start-Package 'after-reset'
$env:ADMIN_PASSWORD = 'ci-new-password-456'
& node (Join-Path $repo 'tests\package\smoke.mjs') verify
if ($LASTEXITCODE -ne 0) { throw '重置密码后登录失败' }

Invoke-Bat '2-停止系统.bat'
Write-Host 'Windows 一键部署包验证通过' -ForegroundColor Green
