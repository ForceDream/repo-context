#!/usr/bin/env node
/**
 * PR 复核入口（2026-09-16）：把 `repoctx affected` 包成**可直接贴进 PR 描述**的 Markdown。
 *
 * 为什么是可移植脚本而不是平台 CI 配置：本仓库 remote 是自建裸仓库
 * （ssh://…/opt/git/your-repo.git），仓库内没有任何 CI 配置（.github/workflows、
 * .gitlab-ci.yml、Jenkinsfile 均不存在）。所以给一个到处都能调的入口：
 * 本地预推、`.git/hooks/pre-push`、Gitea Actions / Jenkins / 手工，共用同一份逻辑。
 *
 * 用法：
 *   node tools/repo-context/scripts/pr-affected.mjs                    # 对比 origin/HEAD（merge-base）
 *   node tools/repo-context/scripts/pr-affected.mjs --base main --depth 2 --top 20
 *   node tools/repo-context/scripts/pr-affected.mjs --files a.rs,b.ts  # 直接给文件（不走 git）
 *   node tools/repo-context/scripts/pr-affected.mjs --out affected.md  # 写文件（默认打屏）
 *
 * 设计原则：
 *   · **不做门禁**——"有波及符号"是信息不是失败；要 gate 请在外层加阈值判断；
 *   · **git 只由 repoctx 调**（它有 resolveGit 的 PATH 兜底）——本脚本自己碰 git 会在
 *     git 不在 PATH 的环境里静默失败（实测踩过）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)

// 仓库根：从 cwd 逐级上溯找 .git；**找不到就回到 cwd**，交给 repoctx 自己报错。
// ⚠️ 这里踩过一个真坑（2026-09-16 测试抓出）：原实现"边走边赋值 root"，走到盘根时 `root` 已经变成
// `C:\`，于是在非 git 目录里运行会去**索引整个盘**（实测 `EPERM: scandir 'C:\$Recycle.Bin'`）。
// 上溯只允许"发现 .git 才接受"，否则保持 cwd 不变。
const cwd = process.cwd()
let root = cwd
for (let i = 0; i < 12; i++) {
  if (fs.existsSync(path.join(root, '.git'))) break
  const up = path.dirname(root)
  if (up === root) { root = cwd; break } // 到顶仍未找到 → 回到 cwd，绝不当成盘根
  root = up
}

const repoctx = (args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(HERE, 'repoctx.mjs'), ...args, '--repo', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') } }
}

// 索引必须新鲜（affected 依赖 map.json）；过期先重建——唯一"自动写"动作，且幂等
if (!repoctx(['check']).ok) {
  console.error('索引过期或缺失，正在重建（repoctx index）…')
  const idx = repoctx(['index'])
  if (!idx.ok) { console.error('✗ 重建失败：\n' + idx.out); process.exit(2) }
}

const depth = String(flag('depth', '2'))
const top = String(flag('top', '20'))
// 改动文件：--files 直给；否则交给 repoctx 的 --diff（merge-base 语义 + git PATH 兜底）
const res = has('files')
  ? repoctx(['affected', '--files', flag('files', ''), '--depth', depth, '--top', top])
  : repoctx(['affected', '--diff', String(flag('base', 'origin/HEAD')), '--depth', depth, '--top', top])
if (!res.ok) { console.error('✗ affected 失败：\n' + res.out); process.exit(2) }

// 属性解析：**不要**用"一条长正则 + 可选组"——原实现写的是
// `/<affected files="(\d+)"…[^>]*?( base="([0-9a-f]+)")?/`，惰性 `[^>]*?` 配可选组永远直接成功，
// 于是 `base=` 静默捕获不到（Markdown 里少写 merge-base sha，而原始输出里明明有）。
// 交给"先取标签体、再逐属性取"两步，属性增删都不会再失手。
const tagBody = (/<affected ([^>]*)>/.exec(res.out) || [, ''])[1]
const attr = (name, dflt = '?') => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tagBody)
  return m ? m[1] : dflt
}
const filesN = attr('files')
const seedsN = attr('seeds')
const affN = attr('affected')
const baseSha = attr('base', null)
const md = [
  '### 改动波及面（repoctx affected）',
  '',
  `- 基准：\`${flag('base', 'origin/HEAD')}\`${baseSha ? `（merge-base ${baseSha}）` : ''}`,
  `- 改动文件 ${filesN} 个 · 涉及符号（seed）${seedsN} 个 · **受影响符号 ${affN} 个**`,
  `- 口径：in-edges 闭包（depth=${depth}）；每条边都带 prov（确定性绑定，无推断）；歧义名不连边并在原始输出里标注`,
  '',
  '<details><summary>原始输出（可复核）</summary>',
  '',
  '```',
  res.out.trimEnd(),
  '```',
  '',
  '</details>',
  '',
].join('\n')

const outFile = flag('out', null)
if (outFile) {
  fs.writeFileSync(path.resolve(root, outFile), md, 'utf8')
  console.log(`✓ 已写入 ${outFile}（${md.length} 字节）`)
} else {
  console.log(md)
}
