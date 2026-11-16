# 修复 DSH 的 web_fetch「fetch failed」
#
# 根因：Watt Toolkit（Steam++，代码里的 NetAccelerator）开了「网络加速」——
#   它把 github.com / raw.githubusercontent.com / www.google.com 等 47 个域名
#   写进 hosts 指向 127.0.0.1，并在 127.0.0.1:443 起一个 TLS 中间人，
#   用自签的 "NetAccelerator Root CA" 签发证书。这个根证书只装在 Windows 证书库里，
#   而 DSH 的 web_fetch 走 Node 内置的 undici，只信 Node 自带的 CA 包 →
#   UNABLE_TO_VERIFY_LEAF_SIGNATURE → 工具报 "web fetch failed: TypeError: fetch failed"。
#
# 本脚本只做两件事：把 NetAccelerator 根证书导成 PEM，再把 NODE_EXTRA_CA_CERTS 设为用户级环境变量。
# 不改 hosts、不改注册表里的证书、不动 Watt Toolkit。
#
# 用法（普通 PowerShell 即可，不需要管理员）：右键「使用 PowerShell 运行」，或：
#   pwsh -File fix-web-fetch-ca.ps1

$ErrorActionPreference = 'Stop'

$pem = Join-Path $env:USERPROFILE '.dsh\netaccelerator-ca.pem'
$dir = Split-Path -Parent $pem
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# 1) 从两个证书存储里取 NetAccelerator 根证书，按指纹去重后导成 PEM
$certs = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -match 'NetAccelerator' } |
    Sort-Object Thumbprint -Unique

if (-not $certs) {
    Write-Warning '证书库里找不到 NetAccelerator 根证书。请先启动 Watt Toolkit 并开启「网络加速」，再重跑本脚本。'
    exit 1
}

$sb = [System.Text.StringBuilder]::new()
foreach ($c in $certs) {
    [void]$sb.AppendLine("# $($c.Subject)  expires $($c.NotAfter.ToString('yyyy-MM-dd'))")
    [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
    [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))
    [void]$sb.AppendLine('-----END CERTIFICATE-----')
}
[System.IO.File]::WriteAllText($pem, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
Write-Host "已导出 $($certs.Count) 张证书 -> $pem"

# 2) 设为用户级环境变量（Node 只在进程启动时读取）
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $pem, 'User')
Write-Host "已设置用户环境变量 NODE_EXTRA_CA_CERTS=$pem"

# 3) 自检：用当前 Node 直接验证
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $env:NODE_EXTRA_CA_CERTS = $pem
    & $node.Source -e "fetch('https://raw.githubusercontent.com/nodejs/node/main/README.md').then(r=>console.log('自检通过: raw.githubusercontent.com ->', r.status)).catch(e=>{console.log('自检失败:', (e.cause&&(e.cause.code||e.cause.message))||e.message); process.exitCode=1})"
}

Write-Host ''
Write-Host '接下来：完全退出 DSH（托盘图标也要退出），再重新打开。' -ForegroundColor Yellow
Write-Host '如果仍不行：注销/重启一次（Explorer 会缓存环境变量块），然后再启动 DSH。' -ForegroundColor Yellow
