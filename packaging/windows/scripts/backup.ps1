# 手动备份：生成可恢复的数据库检查点到 data\backups
. (Join-Path $PSScriptRoot 'common.ps1')

Install-Runtime
$cfg = Get-Config
if (-not (Test-Path (Join-Path $PgData 'PG_VERSION'))) { Stop-WithError '还没有任何数据（系统尚未启动过）' }
Start-Database $cfg

$file = Join-Path $BackupDir ("manual-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step '备份数据库'
& (Join-Path $PgBin 'pg_dump.exe') -h 127.0.0.1 -p $cfg.dbPort -U postgres -Fc -f $file $DbName
if ($LASTEXITCODE -ne 0) { Stop-WithError '备份失败' }
& (Join-Path $PgBin 'pg_restore.exe') -l $file *> $null
if ($LASTEXITCODE -ne 0) { Stop-WithError '备份文件校验失败' }
$escaped = $file.Replace("'", "''")
Invoke-Sql $cfg "INSERT INTO maintenance_log (action, details) VALUES ('CHECKPOINT', jsonb_build_object('label', '手动备份', 'file', '$escaped', 'by', '3-备份数据'))" | Out-Null
Write-Ok "备份完成：$file"
Write-Note '建议把备份文件另存到 U 盘一份。'
if (-not $env:BIDDING_NO_EXPLORER) { Start-Process explorer.exe $BackupDir }
