# 停止竞标服务与数据库（数据保留）
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Step '停止竞标服务'
$n = Stop-AppServer
if ($n -gt 0) { Write-Ok "已停止 $n 个服务进程" } else { Write-Note '服务未在运行' }

Write-Step '停止数据库'
Stop-Database
Write-Ok '数据库已停止（数据已保存）'
