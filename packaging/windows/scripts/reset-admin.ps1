# 重置管理员 admin 的密码
. (Join-Path $PSScriptRoot 'common.ps1')

Install-Runtime
$cfg = Get-Config
Start-Database $cfg
Set-AppEnv $cfg ([int]$cfg.appPort) 'http://localhost'
& $NodeExe (Join-Path $AppDir 'apps\server\dist\migrate.js') *> (Join-Path $LogDir 'migrate.log')
if ($LASTEXITCODE -ne 0) { Stop-WithError "数据库迁移失败，详见 $LogDir\migrate.log" }
Write-Step '重置管理员 admin 的密码'
$pw = if ($env:BIDDING_ADMIN_PASSWORD) { $env:BIDDING_ADMIN_PASSWORD } else { Read-NewPassword '请输入新密码（至少 10 位）' }
Set-AdminPassword $pw
Write-Ok '密码已重置，账号仍为 admin'
