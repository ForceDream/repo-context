#!/usr/bin/env node
/**
 * 安装 git hooks（2026-09-16）：把 PR 复核入口挂进本地流程。
 *
 * 装的是 `pre-push`：推送前打印"改动波及面"（seeds + 受影响符号），让作者在推之前就看到影响面。
 * 产物写到 `.git/repoctx-affected.md`（**不脏工作区**）。
 *
 * 用法：
 *   node tools/repo-context/scripts/install-hooks.mjs              # 安装/更新
 *   node tools/repo-context/scripts/install-hooks.mjs --uninstall  # 移除托管块
 *   node tools/repo-context/scripts/install-hooks.mjs --repo DIR   # 指定仓库根
 *
 * 设计：
 *   · **只动托管块**（`# >>> repo-context >>>` … `# <<< repo-context <<<`），已有 hook 的其余内容原样保留；
 *   · 幂等（重复安装只是替换托管块）；
 *   · **不做门禁**——hook 末尾 `exit 0`，永不阻断推送；
 *   · node 用 install 时解析到的绝对路径兜底（本机 node 不在 PATH 上，实测踩过）。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const uninstall = argv.includes('--uninstall')

let root = path.resolve(flag('repo', process.cwd()))
for (let i = 0; i < 12 && !fs.existsSync(path.join(root, '.git')); i++) {
  const up = path.dirname(root)
  if (up === root) break
  root = up
}
if (!fs.existsSync(path.join(root, '.git'))) { console.error(`✗ 找不到 .git（从 ${process.cwd()} 上溯）——用 --repo 指定仓库根`); process.exit(2) }

const hooksDir = path.join(root, '.git', 'hooks')
fs.mkdirSync(hooksDir, { recursive: true })
const hookFile = path.join(hooksDir, 'pre-push')
const BEGIN = '# >>> repo-context (managed block) >>>'
const END = '# <<< repo-context (managed block) <<<'

const existing = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : ''
const lines = existing.split('\n')
const out = []
let skipping = false
for (const line of lines) {
  if (line.trim() === BEGIN) { skipping = true; continue }
  if (line.trim() === END) { skipping = false; continue }
  if (!skipping) out.push(line)
}
let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()

if (uninstall) {
  const cleaned = body ? body + '\n' : ''
  // 判定"是否还有别的内容"时必须**忽略 shebang**：安装时若原本没有 hook，`#!/bin/sh` 是**我们自己注入的**；
  // 若把它当内容，则 install → uninstall 会留下一个光秃秃的 `#!/bin/sh`（实测踩过，测试抓出）。
  const meaningful = cleaned.replace(/^#!.*\n?/, '').trim()
  if (!meaningful) { fs.rmSync(hookFile, { force: true }); console.log('✓ 已移除 pre-push（无其它内容）') }
  else { fs.writeFileSync(hookFile, cleaned, 'utf8'); console.log('✓ 已移除托管块（保留了 hook 的其余内容）') }
  process.exit(0)
}

const nodeFallback = process.execPath.replace(/\\/g, '/') // sh 里 `[ -x ]` 需要 POSIX 风格路径（反斜杠测不过，实测）
const relScript = path.relative(root, path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'pr-affected.mjs')).split(path.sep).join('/')
const block = [
  BEGIN,
  '# 推送前打印"改动波及面"（信息，不阻断推送）。移除：node ' + relScript.replace('pr-affected.mjs', 'install-hooks.mjs') + ' --uninstall',
  'REPOCTX_NODE="$(command -v node 2>/dev/null || true)"',
  `[ -z "$REPOCTX_NODE" ] && REPOCTX_NODE="${nodeFallback}"`,
  `if [ -x "$REPOCTX_NODE" ]; then`,
  `  "$REPOCTX_NODE" "${relScript}" --base origin/HEAD --out .git/repoctx-affected.md >/dev/null 2>&1 || true`,
  `  [ -f .git/repoctx-affected.md ] && cat .git/repoctx-affected.md 1>&2`,
  'fi',
  'exit 0',
  END,
].join('\n')

if (!body) body = '#!/bin/sh'
if (!body.startsWith('#!')) body = '#!/bin/sh\n' + body
fs.writeFileSync(hookFile, body.trimEnd() + '\n\n' + block + '\n', 'utf8')
try { fs.chmodSync(hookFile, 0o755) } catch { /* Windows 无 chmod */ }
console.log(`✓ 已安装 pre-push（${path.relative(process.cwd(), hookFile)}）`)
console.log(`  node 兜底路径：${nodeFallback}`)
console.log(`  复核脚本：${relScript}`)
