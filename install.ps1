<#
  一键安装 repo-context 到 Agent 用户级技能目录（幂等，可重复跑）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
    powershell ... -File install.ps1 -Target "$env:USERPROFILE\.agent-skills\repo-context"
    powershell ... -File install.ps1 -WithDeps     # 本包若不含 node_modules，则在目标目录执行 npm install（AST 增强）

  说明：
    · 核心（行级抽取）零依赖，只要 Node 即可运行；
    · 本包若已带 node_modules（tree-sitter wasm），会直接复制 → 离线可用；
    · 不带 node_modules 且不加 -WithDeps 时，自动使用行级抽取（功能完整、精度略低）。

[CmdletBinding()]
param(
    [string]$Target = "$env:USERPROFILE\.agent-skills\repo-context",
    [switch]$WithDeps
)

$ErrorActionPreference = 'Continue'
$src = $PSScriptRoot

Write-Host '== repo-context 安装 =='
Write-Host "  源  : $src"
Write-Host "  目标: $Target"

New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Force "$src\SKILL.md", "$src\package.json", "$src\package-lock.json" $Target
Copy-Item -Recurse -Force "$src\scripts" $Target
if (Test-Path "$src\docs") { Copy-Item -Recurse -Force "$src\docs" $Target }

if (Test-Path "$src\node_modules\tree-sitter-wasms") {
    Write-Host '  含 node_modules（AST 增强）→ 一并复制'
    Copy-Item -Recurse -Force "$src\node_modules" $Target
} elseif ($WithDeps) {
    Write-Host '  本包不含 node_modules 且指定 -WithDeps → 在目标目录执行 npm install'
    Push-Location $Target
    npm install --no-audit --no-fund
    Pop-Location
} else {
    Write-Host '  未带 node_modules 且未指定 -WithDeps → 使用行级抽取（功能完整、精度略低）'
}

Write-Host ''
Write-Host '完成。用法（在任意 git 仓库目录）：'
Write-Host "  node `"$Target\scripts\repoctx.mjs`" index"
Write-Host "  node `"$Target\scripts\repoctx.mjs`" for `"<english keywords>`""
Write-Host "  node `"$Target\scripts\repoctx.mjs`" impact <符号名> --depth 3"
Write-Host "自测： cd `"$Target`"; npm test"
