# 测试LLM.ps1
# LLM Key 测试脚本 —— PowerShell 版（兼容 Windows 默认环境）

$ErrorActionPreference = 'Continue'

# ========== 颜色输出函数 ==========
function Write-Success($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Err($msg) { Write-Host $msg -ForegroundColor Red }

Write-Host ""
Write-Host "====================================================" -ForegroundColor Yellow
Write-Host "  LLM Key 测试 —— 验证 Key 是否有效" -ForegroundColor Yellow
Write-Host "====================================================" -ForegroundColor Yellow
Write-Host ""

# ========== 0. 切到脚本所在目录 ==========
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Write-Info "[0/4] 切到脚本目录: $scriptDir"
Set-Location -LiteralPath $scriptDir
Write-Host "  当前目录: $(Get-Location)"
Write-Host ""

# ========== 1. 找 Node.js ==========
Write-Info "[1/4] 查找 Node.js..."

$nodeExe = $null

# 尝试常见路径
$candidates = @(
  "$env:LOCALAPPDATA\Tencent\微信web开发者工具\code\node.exe",
  "C:\Program Files\nodejs\node.exe",
  "C:\Program Files (x86)\nodejs\node.exe",
  "$env:ProgramFiles\nodejs\node.exe",
  "$env:ProgramFiles(x86)\nodejs\node.exe",
  "C:\Users\Tiger\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
  "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
)
foreach ($p in $candidates) {
  if ($p -and (Test-Path $p)) {
    $nodeExe = $p
    break
  }
}

# 用 where 兜底
if (-not $nodeExe) {
  $whereOut = & where node.exe 2>$null
  if ($whereOut -and (Test-Path $whereOut[0])) {
    $nodeExe = $whereOut[0]
  }
}

if ($nodeExe) {
  Write-Success "  ✓ 找到 Node.js: $nodeExe"
  $ver = & "$nodeExe" --version 2>$null
  Write-Success "  ✓ 版本: $ver"
} else {
  Write-Err "  ✗ 没找到 Node.js！"
  Write-Host ""
  Write-Host "请先装 Node.js（任选一种方法）：" -ForegroundColor Yellow
  Write-Host "  1. 装 LTS 版: https://nodejs.org/  (10 分钟)" -ForegroundColor Gray
  Write-Host "  2. 用 winget: winget install OpenJS.NodeJS.LTS" -ForegroundColor Gray
  Write-Host ""
  Read-Host "按 Enter 退出"
  exit 1
}
Write-Host ""

# ========== 2. 找 .env.local ==========
Write-Info "[2/4] 查找 .env.local..."
if (-not (Test-Path .\.env.local)) {
  Write-Err "  ✗ .env.local 不存在！"
  Write-Host "  应该在: $(Get-Location)\.env.local" -ForegroundColor Gray
  Read-Host "按 Enter 退出"
  exit 1
}
Write-Success "  ✓ 找到 .env.local"
Write-Host ""

# ========== 3. 跑测试 ==========
Write-Info "[3/4] 测试 LLM 连接..."
Write-Host ""
& "$nodeExe" scripts\test-llm.js
$exitCode = $LASTEXITCODE
Write-Host ""

# ========== 4. 总结 ==========
Write-Host "====================================================" -ForegroundColor Green
if ($exitCode -eq 0) {
  Write-Success "  ✓ 测试通过！你的 Key 能用，可以部署云函数了"
} else {
  Write-Err "  ✗ 测试失败 (exit code: $exitCode)"
  Write-Host ""
  Write-Host "常见原因：" -ForegroundColor Yellow
  Write-Host "  - HTTP 401: Key 无效或被吊销 → 去 DashScope 重新创建" -ForegroundColor Gray
  Write-Host "  - HTTP 402: 余额不足 → 充值 1 元" -ForegroundColor Gray
  Write-Host "  - 网络超时: 检查代理 / 防火墙" -ForegroundColor Gray
}
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""
Read-Host "按 Enter 退出"