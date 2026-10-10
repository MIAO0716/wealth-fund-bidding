# 组装 Windows 一键部署包（在 Windows 构建机上运行，需先执行 npm ci 与 npm run build）
# 产物：dist-package\BiddingSystem-windows-x64.zip
#   BiddingSystem\
#     1-启动系统.bat … 5-重置管理员密码.bat、使用说明.txt
#     runtime\node\node.exe          便携 Node.js
#     runtime\pgsql\{bin,lib,share}  便携 PostgreSQL（含 VC++ 运行库）
#     runtime\app\                   构建好的前后端与生产依赖
#     runtime\scripts\*.ps1          启动/停止/备份/恢复脚本
#     runtime\VERSION
param(
  [string]$OutDir = 'dist-package',
  [string]$NodeVersion = '22.23.3',
  # 依次尝试，使用第一个可下载的版本（EnterpriseDB 官方 Windows 二进制包）
  [string[]]$PgVersions = @('16.13-1', '16.12-1', '16.11-1', '16.10-1')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

$out = Join-Path $repo $OutDir
$stage = Join-Path $out 'BiddingSystem'
$runtime = Join-Path $stage 'runtime'
$cache = Join-Path $out 'cache'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $runtime, $cache | Out-Null

function Get-File([string]$url, [string]$dest) {
  if (Test-Path $dest) { return $true }
  try {
    Invoke-WebRequest -Uri $url -OutFile "$dest.part" -UseBasicParsing
    Move-Item "$dest.part" $dest -Force
    return $true
  } catch {
    Remove-Item "$dest.part" -ErrorAction SilentlyContinue
    return $false
  }
}

# ---------------------------------------------------------------- 应用
Write-Host '==> 应用程序'
foreach ($p in @('apps\server\dist', 'apps\web\dist')) {
  if (-not (Test-Path (Join-Path $repo $p))) { throw "缺少 $p，请先执行 npm run build" }
}
$app = Join-Path $runtime 'app'
New-Item -ItemType Directory -Force -Path (Join-Path $app 'apps\server'), (Join-Path $app 'apps\web') | Out-Null
Copy-Item (Join-Path $repo 'apps\server\dist') (Join-Path $app 'apps\server\dist') -Recurse
Get-ChildItem (Join-Path $app 'apps\server\dist') -Filter *.map | Remove-Item
Copy-Item (Join-Path $repo 'apps\server\migrations') (Join-Path $app 'apps\server\migrations') -Recurse
Copy-Item (Join-Path $repo 'apps\server\package.json') (Join-Path $app 'apps\server\package.json')
Copy-Item (Join-Path $repo 'apps\web\dist') (Join-Path $app 'apps\web\dist') -Recurse

# 只安装服务端生产依赖（按根目录 package-lock.json 锁定的版本）
Write-Host '==> 生产依赖'
$deps = Join-Path $out 'deps'
if (Test-Path $deps) { Remove-Item $deps -Recurse -Force }
foreach ($f in @('package.json', 'package-lock.json', '.npmrc', 'packages\shared\package.json', 'apps\server\package.json', 'apps\web\package.json')) {
  $d = Join-Path $deps $f
  New-Item -ItemType Directory -Force -Path (Split-Path $d) | Out-Null
  Copy-Item (Join-Path $repo $f) $d
}
Push-Location $deps
try {
  npm ci --omit=dev --workspace '@bidding/server' --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
} finally { Pop-Location }
# 工作区链接不进入安装包（共享包已打包进 dist）
Remove-Item (Join-Path $deps 'node_modules\@bidding') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $deps 'node_modules\.bin') -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Join-Path $deps 'node_modules') (Join-Path $app 'node_modules')
Copy-Item (Join-Path $repo 'package.json') (Join-Path $app 'package.json')

# ---------------------------------------------------------------- Node.js
Write-Host "==> Node.js $NodeVersion"
$nodeZip = Join-Path $cache "node-v$NodeVersion-win-x64.zip"
if (-not (Get-File "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $nodeZip)) { throw 'Node.js 下载失败' }
$sums = Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$expected = ($sums.Content -split "`n" | Where-Object { $_ -match "node-v$NodeVersion-win-x64\.zip$" }) -replace '\s+.*$', ''
$actual = (Get-FileHash $nodeZip -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) { throw "Node.js 校验失败：$actual ≠ $expected" }
$nodeTmp = Join-Path $out 'node-tmp'
if (Test-Path $nodeTmp) { Remove-Item $nodeTmp -Recurse -Force }
Expand-Archive $nodeZip $nodeTmp
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'node') | Out-Null
Copy-Item (Join-Path $nodeTmp "node-v$NodeVersion-win-x64\node.exe") (Join-Path $runtime 'node\node.exe')
Copy-Item (Join-Path $nodeTmp "node-v$NodeVersion-win-x64\LICENSE") (Join-Path $runtime 'node\LICENSE')

# ---------------------------------------------------------------- PostgreSQL
$pgUsed = $null
foreach ($v in $PgVersions) {
  $pgZip = Join-Path $cache "postgresql-$v-windows-x64-binaries.zip"
  Write-Host "==> 尝试 PostgreSQL $v"
  if (Get-File "https://get.enterprisedb.com/postgresql/postgresql-$v-windows-x64-binaries.zip" $pgZip) { $pgUsed = $v; break }
}
if (-not $pgUsed) { throw 'PostgreSQL 下载失败' }
$pgTmp = Join-Path $out 'pg-tmp'
if (Test-Path $pgTmp) { Remove-Item $pgTmp -Recurse -Force }
& 7z x $pgZip "-o$pgTmp" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 解压失败' }
$pg = Join-Path $runtime 'pgsql'
New-Item -ItemType Directory -Force -Path $pg | Out-Null
foreach ($d in @('bin', 'lib', 'share')) { Copy-Item (Join-Path $pgTmp "pgsql\$d") (Join-Path $pg $d) -Recurse }
# 精简：去掉调试符号、图形工具
Get-ChildItem $pg -Recurse -Include *.pdb | Remove-Item -Force
Remove-Item (Join-Path $pg 'bin\pgAdmin*'), (Join-Path $pg 'bin\stackbuilder*') -Recurse -Force -ErrorAction SilentlyContinue
# 随包附带 VC++ 运行库（新电脑可能未安装）
foreach ($dll in @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'concrt140.dll')) {
  $target = Join-Path $pg "bin\$dll"
  $src = Join-Path $env:SystemRoot "System32\$dll"
  if (-not (Test-Path $target) -and (Test-Path $src)) { Copy-Item $src $target }
}

# ---------------------------------------------------------------- 脚本与说明
Write-Host '==> 脚本'
Copy-Item (Join-Path $PSScriptRoot 'scripts') (Join-Path $runtime 'scripts') -Recurse
Get-ChildItem $PSScriptRoot -Filter *.bat | Copy-Item -Destination $stage
Copy-Item (Join-Path $PSScriptRoot '使用说明.txt') $stage

$sha = (git rev-parse --short HEAD).Trim()
$date = Get-Date -Format 'yyyyMMdd-HHmm'
$version = "$date-$sha node$NodeVersion pg$pgUsed"
[IO.File]::WriteAllText((Join-Path $runtime 'VERSION'), $version)
Write-Host "版本：$version"

# ---------------------------------------------------------------- 压缩（UTF-8 文件名）
$zip = Join-Path $out 'BiddingSystem-windows-x64.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Push-Location $out
try {
  & 7z a -tzip -mcu=on -mx=7 $zip 'BiddingSystem' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '压缩失败' }
} finally { Pop-Location }
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "完成：$zip（$size MB）"
"version=$version" | Out-File -FilePath (Join-Path $out 'build-info.txt') -Encoding utf8
