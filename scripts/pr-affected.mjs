#!/usr/bin/env node



















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





const cwd = process.cwd()
let root = cwd
for (let i = 0; i < 12; i++) {
  if (fs.existsSync(path.join(root, '.git'))) break
  const up = path.dirname(root)
  if (up === root) { root = cwd; break }
  root = up
}

const repoctx = (args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(HERE, 'repoctx.mjs'), ...args, '--repo', root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  } catch (e) { return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') } }
}


if (!repoctx(['check']).ok) {
  console.error('索引过期或缺失，正在重建（repoctx index）…')
  const idx = repoctx(['index'])
  if (!idx.ok) { console.error('✗ 重建失败：\n' + idx.out); process.exit(2) }
}

const depth = String(flag('depth', '2'))
const top = String(flag('top', '20'))

const res = has('files')
  ? repoctx(['affected', '--files', flag('files', ''), '--depth', depth, '--top', top])
  : repoctx(['affected', '--diff', String(flag('base', 'origin/HEAD')), '--depth', depth, '--top', top])
if (!res.ok) { console.error('✗ affected 失败：\n' + res.out); process.exit(2) }





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
