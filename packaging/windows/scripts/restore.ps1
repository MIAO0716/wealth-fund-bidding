# 从备份恢复（停写状态下执行）。用法：把 .dump 文件拖到「4-恢复数据」上，或直接运行后按编号选择。
param([string]$File)
. (Join-Path $PSScriptRoot 'common.ps1')

Install-Runtime
$cfg = Get-Config

if (-not $File) {
  $list = @(Get-ChildItem $BackupDir -Filter *.dump -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 10)
  if ($list.Count -eq 0) { Stop-WithError "没有找到备份文件（$BackupDir），也可以把备份文件拖到本程序图标上" }
  Write-Step '最近的备份'
  for ($i = 0; $i -lt $list.Count; $i++) {
    Write-Note ("[{0}] {1}  {2}" -f ($i + 1), $list[$i].LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), $list[$i].Name)
  }
  $n = Read-Host '输入要恢复的编号'
  $idx = 0
  if (-not [int]::TryParse($n, [ref]$idx) -or $idx -lt 1 -or $idx -gt $list.Count) { Stop-WithError '编号无效' }
  $File = $list[$idx - 1].FullName
}
if (-not (Test-Path $File)) { Stop-WithError "备份文件不存在：$File" }

Write-Host ''
Write-Warn2 "即将用备份覆盖当前全部数据：$File"
Write-Warn2 '恢复会先停止竞标服务；恢复后所有领导手机与大屏需要重新扫码/打开链接。'
if ($env:BIDDING_CONFIRM -ne 'RESTORE') {
  $ans = Read-Host '确认恢复请输入 RESTORE'
  if ($ans -ne 'RESTORE') { Write-Note '已取消'; exit 1 }
}

# 停写：先停止服务
$null = Stop-AppServer
Start-Database $cfg

& (Join-Path $PgBin 'pg_restore.exe') -l $File *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithError '备份文件无法读取' }

Write-Step '先备份当前数据'
$before = Join-Path $BackupDir ("before-restore-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& (Join-Path $PgBin 'pg_dump.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres -Fc -f $before $DbName
if ($LASTEXITCODE -ne 0) { Stop-WithError '恢复前备份失败，已中止' }
Write-Ok $before

Write-Step '恢复数据'
& (Join-Path $PgBin 'pg_restore.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres --clean --if-exists --no-owner --no-privileges -d $DbName $File *> (Join-Path $LogDir 'restore.log')
if ($LASTEXITCODE -ne 0) { Write-Warn2 "pg_restore 有警告，详见 $LogDir\restore.log" }

$f = $File.Replace("'", "''")
$b = $before.Replace("'", "''")
Invoke-Sql $cfg @"
UPDATE sessions SET revoked_at = now(), revoke_reason = '备份恢复后统一失效' WHERE role IN ('BIDDER', 'SCREEN') AND revoked_at IS NULL;
UPDATE unit_credentials SET revoked_at = now() WHERE used_at IS NULL AND revoked_at IS NULL;
INSERT INTO maintenance_log (action, details) VALUES ('RESTORE', jsonb_build_object('file', '$f', 'before', '$b'));
"@ | Out-Null
Write-Ok '恢复完成。请运行「1-启动系统」，并在管理端重新发放二维码、重新打开大屏链接。'
