# 斗地主 · 一键开启公共网址
# 在你的【自己电脑】上用 PowerShell 运行本脚本（需要能联网，WorkBuddy 沙箱里不行）
# 运行后会：① 确保游戏服务在 localhost:3000 运行 ② 用 cloudflared 建立公共隧道
# 把脚本输出的 https://xxxx.trycloudflare.com 网址发给朋友，他们就能从任何网络加入。
# 注意：请保持这个 PowerShell 窗口开着，关掉隧道就断了。

$ErrorActionPreference = 'Stop'

$NODE   = 'C:\Users\章泓\.workbuddy\binaries\node\versions\22.22.2\node.exe'
$SERVER = 'C:\Users\章泓\WorkBuddy\2026-07-07-10-52-08\doudizhu\server.js'
$CF     = Join-Path $env:USERPROFILE 'cloudflared.exe'
$URL    = 'http://localhost:3000'

Write-Host '==> 检查游戏服务是否已启动 ...'
$up = $false
try {
  $r = Invoke-WebRequest -Uri "$URL/api/health" -UseBasicParsing -TimeoutSec 2
  if ($r.StatusCode -eq 200) { $up = $true; Write-Host '    游戏服务已在运行' }
} catch { $up = $false }

if (-not $up) {
  Write-Host '    启动游戏服务 ...'
  Start-Process -FilePath $NODE -ArgumentList $SERVER -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Write-Host '==> 检查 cloudflared ...'
if (-not (Test-Path $CF)) {
  Write-Host '    下载 cloudflared（需要联网）...'
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $CF
}

Write-Host ''
Write-Host '==> 正在建立公共隧道，请把下面输出的网址发给朋友（保持此窗口开启）...'
& $CF tunnel --url $URL
