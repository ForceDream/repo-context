#!/usr/bin/env node
/**
 * 声明层审计（declaration layer audit）——**把"抽取器漏了什么"从人肉发现变成一次普查**
 *
 * 背景：`const { a, b } = obj`（解构）与类型标注（`x: Foo`）这类空白，此前没人去找就永远发现不了。
 * 本工具把全仓每个文件解析一遍，统计**所有节点类型**的出现次数，与 `repoctx-decls.mjs` 的登记表比对：
 *
 *   已抽   extracted  ：正常
 *   待补   planned    ：登记表里已识别但未抽取 → **带量级的补齐清单**
 *   不抽   skipped    ：明确不抽（附理由，避免重复讨论）
 *   未归类 （未登记） ：**新发现**——打印样例，人看完决定归到上面哪一类（这就是"发现缺的也好补充"）
 *   过期   零出现     ：登记为 planned/skipped 但全仓从未出现 → 语法版本变了或当初判断错了
 *
 * 用法：
 *   node scripts/repoctx-decl-audit.mjs [--repo .] [--top 12] [--json] [--strict]
 *   --strict：存在"未归类"或登记表自检问题时退出码 2（留给 CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAstExtractor } from './repoctx-ast.mjs'
import { DECL_FORMS, classifyCounts, formsLangKey, mergeClassified, selfCheck, sumCounts } from './repoctx-decls.mjs'
// 文件选择层与索引共用（**必须共用**：首跑时自走一遍目录得到 2472 个文件 vs 索引 330 个，
// 缺口榜被 archive/ 废弃代码的形态淹没——结论完全失真）
import { LANG_BY_EXT, MAX_FILE_BYTES, listSourceFiles } from './repoctx-files.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); if (i < 0) return dflt; const v = argv[i + 1]; return v && !v.startsWith('--') ? v : true }
const REPO = path.resolve(String(flag('repo', process.cwd())))
const TOP = Number(flag('top', 12))
const JSON_OUT = argv.includes('--json')
const STRICT = argv.includes('--strict')
const WASM_DIR = process.env.REPOCTX_WASM_DIR || path.join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out')

/** 与索引同一套文件选择 + 同一套语言映射；md 与非源码跳过（census 无对应语法） */
function sourceFiles() {
  return listSourceFiles(REPO)
    .map((rel) => ({ rel, lang: LANG_BY_EXT[path.extname(rel).toLowerCase()] }))
    .filter((f) => f.lang && f.lang !== 'md')
}

const ex = await createAstExtractor({ wasmDir: WASM_DIR })
if (!ex.available) {
  console.error(`AST 不可用：${ex.reason}`)
  console.error('（声明层普查需要 AST；先 npm install web-tree-sitter tree-sitter-wasms）')
  process.exit(3)
}

const files = sourceFiles()
// ⚠ 聚合键用**登记表键**（tsx→ts、jsx→js），不是文件扩展名：ts/tsx 共用同一份登记表，
// 按扩展名分开比对会产生**假过期**（`type_parameter` 在 ts 里出现、tsx 里没有 → 在 tsx 段被误报"零出现"）。
const countsByLang = new Map() // 登记表键 → [Map]
const samplesByLang = new Map() // 登记表键 → Map(node → 样例)
const fileCountByLang = new Map() // 登记表键 → 文件数
let parsed = 0
for (const f of files) {
  let text
  try { text = fs.readFileSync(path.join(REPO, f.rel), 'utf8') } catch { continue }
  const r = ex.nodeTypeCensus(f.rel, f.lang, text)
  if (!r) continue
  parsed++
  const key = formsLangKey(f.lang)
  if (!countsByLang.has(key)) { countsByLang.set(key, []); samplesByLang.set(key, new Map()); fileCountByLang.set(key, 0) }
  countsByLang.get(key).push(r.counts)
  fileCountByLang.set(key, fileCountByLang.get(key) + 1)
  const sk = samplesByLang.get(key)
  for (const [t, s] of r.samples) if (!sk.has(t)) sk.set(t, s)
}

const res = {}
for (const [lang, maps] of countsByLang) {
  const total = sumCounts(maps)
  res[lang] = { counts: total, cls: classifyCounts(lang, total), samples: samplesByLang.get(lang), files: fileCountByLang.get(lang) }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    repo: '.', files: files.length, parsed,
    problems: selfCheck(),
    merged: mergeClassified(Object.fromEntries(Object.entries(res).map(([l, r]) => [l, r.cls]))),
  }, null, 1))
} else {
  const problems = selfCheck()
  console.log(`声明层审计 · 仓库 ${REPO} · 源文件 ${files.length}（已解析 ${parsed}）`)
  if (problems.length) {
    console.log('\n⚠ 登记表自检问题：')
    for (const p of problems) console.log('  ! ' + p)
  }
  let plannedTotal = 0, plannedKinds = 0, unclassifiedTotal = 0, unclassifiedKinds = 0, declLikeTotal = 0
  const stale = []
  for (const [lang, { counts, cls, samples, files: nFiles }] of Object.entries(res)) {
    const sum = (arr) => arr.reduce((s, x) => s + x.count, 0)
    // "声明样"总量 = 四类之和（即：本语言里**被识别为声明/绑定层面**的节点总数），
    // 用作"待补占比"的分母——直接取分类结果，别再自己过滤一遍计数表（首版那样算出来恒为 NaN/0）
    declLikeTotal += sum(cls.extracted) + sum(cls.planned) + sum(cls.skipped) + sum(cls.unclassified)
    console.log(`\n── ${lang}（文件 ${nFiles} · 节点类型 ${counts.size} 种）${'─'.repeat(20)}`)
    console.log(`  已抽形态 ${cls.extracted.length} 种（出现 ${sum(cls.extracted).toLocaleString()} 次）`)
    for (const x of cls.extracted.slice(0, 6)) console.log(`    ✓ ${x.node.padEnd(30)} ${String(x.count).padStart(8)}`)
    if (cls.extracted.length > 6) console.log(`    … 其余 ${cls.extracted.length - 6} 种见 --json`)
    plannedTotal += sum(cls.planned); plannedKinds += cls.planned.length
    if (cls.planned.length) {
      console.log(`  待补形态 ${cls.planned.length} 种（出现 ${sum(cls.planned).toLocaleString()} 次）← 补齐清单`)
      for (const x of cls.planned.slice(0, TOP)) console.log(`    ☐ ${x.node.padEnd(30)} ${String(x.count).padStart(8)}  ${(x.why || '').slice(0, 60)}`)
    }
    if (cls.skipped.length) {
      console.log(`  不抽形态 ${cls.skipped.length} 种（出现 ${sum(cls.skipped).toLocaleString()} 次）`)
      for (const x of cls.skipped.slice(0, 4)) console.log(`    — ${x.node.padEnd(30)} ${String(x.count).padStart(8)}  ${(x.why || '').slice(0, 52)}`)
      if (cls.skipped.length > 4) console.log(`    … 其余 ${cls.skipped.length - 4} 种`)
    }
    unclassifiedTotal += sum(cls.unclassified); unclassifiedKinds += cls.unclassified.length
    if (cls.unclassified.length) {
      console.log(`  未归类 ${cls.unclassified.length} 种（出现 ${sum(cls.unclassified).toLocaleString()} 次）← 新发现，看完样例请归类`)
      for (const x of cls.unclassified.slice(0, TOP)) console.log(`    ? ${x.node.padEnd(30)} ${String(x.count).padStart(8)}  ${samples.get(x.node) || ''}`)
    }
    for (const f of DECL_FORMS[lang] || []) {
      if (f.status !== 'extracted' && !counts.has(f.node)) stale.push(`${lang}:${f.node}(${f.status})`)
    }
  }
  if (stale.length) console.log(`\n登记表过期（登记为 planned/skipped 但全仓零出现）${stale.length} 项：\n  ${stale.slice(0, 14).join('  ')}${stale.length > 14 ? ' …' : ''}`)
  const pct = declLikeTotal ? ((100 * plannedTotal) / declLikeTotal).toFixed(1) : '0.0'
  console.log(`\n── 汇总 ──\n  待补 ${plannedKinds} 种 / ${plannedTotal.toLocaleString()} 次（占"声明样"节点 ${pct}%）`)
  console.log(`  未归类 ${unclassifiedKinds} 种 / ${unclassifiedTotal.toLocaleString()} 次${unclassifiedKinds ? '（新发现）' : ''}`)
  console.log(`  登记表自检：${problems.length ? problems.length + ' 个问题！' : '一致'}`)
}

if (STRICT && (selfCheck().length || Object.values(res).some((r) => r.cls.unclassified.length))) process.exit(2)
