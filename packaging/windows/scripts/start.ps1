# 一键启动：安装/升级程序 → 初始化并启动数据库 → 数据库迁移 → 首次设置管理员密码 → 放行防火墙 → 启动服务 → 打开浏览器
. (Join-Path $PSScriptRoot 'common.ps1')

$Host.UI.RawUI.WindowTitle = '现场竞标系统（关闭此窗口即停止服务）'
Write-Host '=================================================' -ForegroundColor Red
Write-Host '          理财、基金现场竞标系统 · 一键启动' -ForegroundColor Red
Write-Host '=================================================' -ForegroundColor Red

Install-Runtime
$cfg = Get-Config

# 已在运行：直接打开管理端
if (Test-OurServer ([int]$cfg.appPort)) {
  $url = "http://localhost:$($cfg.appPort)/admin"
  Write-Ok "系统已在运行：$url"
  if (-not $env:BIDDING_NO_BROWSER) { Start-Process $url }
  exit 0
}

# 端口：默认 8080，被其他程序占用时依次尝试备用端口
$port = [int]$cfg.appPort
if (-not (Test-PortFree $port)) {
  $alt = @(8090, 18080, 28080) | Where-Object { Test-PortFree $_ } | Select-Object -First 1
  if (-not $alt) { Stop-WithError "端口 $port 被其他程序占用，且备用端口也不可用" }
  Write-Warn2 "端口 $port 被其他程序占用，改用 $alt"
  $port = [int]$alt
}

Start-Database $cfg

$publicBaseUrl = Get-PublicBaseUrl $cfg $port
Set-AppEnv $cfg $port $publicBaseUrl

Write-Step '检查数据库结构'
$code = Invoke-NodeScript 'migrate.js' @() 'migrate'
if ($code -ne 0) { Stop-WithError "数据库迁移失败，详见 $LogDir\migrate.err.log" }
Write-Ok '数据库结构已是最新'

$admins = [int](Invoke-Sql $cfg 'SELECT count(*) FROM admins')
if ($admins -eq 0) {
  Write-Step '首次使用：设置管理员密码（账号为 admin）'
  if ($env:BIDDING_ADMIN_PASSWORD) {
    $pw = $env:BIDDING_ADMIN_PASSWORD
  } else {
    Write-Note '密码至少 10 位，输入时屏幕不显示。请牢记，忘记可运行「5-重置管理员密码」。'
    $pw = Read-NewPassword '请输入管理员密码'
  }
  Set-AdminPassword $pw
  Write-Ok '管理员账号 admin 已创建'
}

Grant-Firewall $port

# 地址变化提醒：二维码里写的是这个地址
if ($cfg.lastPublicBaseUrl -and $cfg.lastPublicBaseUrl -ne $publicBaseUrl) {
  Write-Host ''
  Write-Warn2 "本机访问地址已变化：$($cfg.lastPublicBaseUrl) → $publicBaseUrl"
  Write-Warn2 '此前发放的领导二维码和大屏链接将无法打开，请在管理端「二维码与大屏」重新发放。'
  Write-Warn2 '如需固定地址，请给这台电脑设置固定 IP，或在 config.json 中设置 publicBaseUrl。'
}
$cfg.lastPublicBaseUrl = $publicBaseUrl
$cfg.appPort = $port
Save-Config $cfg

Write-Step '启动竞标服务'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $LogDir "server-$stamp.log"
$errLog = Join-Path $LogDir "server-$stamp.err.log"
$server = Start-Process -FilePath $NodeExe -ArgumentList "`"$(Join-Path $AppDir 'apps\server\dist\main.js')`"" -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$null = $server.Handle

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  if ($server.HasExited) { break }
  if (Test-OurServer $port) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) { Stop-WithError "竞标服务启动失败，详见 $errLog 与 $outLog" }

$adminUrl = "http://localhost:$port/admin"
Write-Host ''
Write-Host '=================================================' -ForegroundColor Green
Write-Host '  系统已启动' -ForegroundColor Green
Write-Host "  管理端（本机）：$adminUrl" -ForegroundColor Green
Write-Host "  手机与大屏使用的地址：$publicBaseUrl" -ForegroundColor Green
Write-Host '  管理员账号：admin' -ForegroundColor Green
Write-Host '-------------------------------------------------'
Write-Host '  · 手机需与本电脑连接同一个 Wi-Fi 才能扫码进入'
Write-Host '  · 关闭此窗口即停止服务（数据自动保存，下次启动继续）'
Write-Host "  · 数据与备份位置：$DataRoot"
Write-Host '=================================================' -ForegroundColor Green

if (-not $env:BIDDING_NO_BROWSER) { Start-Process $adminUrl }

$server.WaitForExit()
Write-Host ''
Write-Warn2 "竞标服务已停止（退出码 $($server.ExitCode)）。日志：$outLog"
exit $server.ExitCode
