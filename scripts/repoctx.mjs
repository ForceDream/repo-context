#!/usr/bin/env node





















import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { LANG_BY_EXT, INDEXED_EXT, SKIP_DIR, MAX_FILE_BYTES, posix, resolveGit, listSourceFiles } from './repoctx-files.mjs'

import { aliasScan, buildEdges, dispatchOf, reexportScan } from './repoctx-edges.mjs'

import { parsePolicy, validatePolicy, runPolicyCheck, fingerprint, POLICY_TEMPLATE } from './repoctx-policy.mjs'
import { SCHEMA, createQueryLayer, esc } from './repoctx-core.mjs'




const argv = process.argv.slice(2)
const cmd = argv[0]
const VALUE_FLAGS = new Set([
  'repo', 'top', 'max-tokens', 'depth', 'out',

  'sym', 'file', 'text', 'tags', 'contains',

  'files', 'diff',

  'by', 'dir',

  'kind', 'alias', 'rel', 'id',

  'max-behind', 'policy',
])
const flags = {}
const positional = []
for (let k = 1; k < argv.length; k++) {
  const a = argv[k]
  const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a)
  if (!m) { positional.push(a); continue }
  const name = m[1]
  if (m[2] !== undefined) flags[name] = m[2]
  else if (VALUE_FLAGS.has(name) && argv[k + 1] !== undefined && !argv[k + 1].startsWith('--')) flags[name] = argv[++k]
  else flags[name] = true
}
const REPO = path.resolve(flags.repo || process.cwd())
const OUT_DIR = path.join(REPO, '.repoctx')
const MAP_FILE = path.join(OUT_DIR, 'map.json')
const NOTES_FILE = path.join(OUT_DIR, 'notes.jsonl')

const INCLUDE_DOCS = Boolean(flags['include-docs'])



const Q = createQueryLayer({ repo: REPO, outDir: OUT_DIR, includeDocs: INCLUDE_DOCS })
const { loadMap, readNotes, callEdges, pagerankOf, inDegree, calleesOf, hubModelOf, ambGroupsOf, collapseRows,
  docCountOf, codeAmbGroups,
  symLine, confNote, resolveSymbol, impactDetail, impact, lensFor, tokenize, estTokens } = Q

const BODY_SCAN_CHARS = 4000
const DOC_LINES = 3


function run(cmd, args, opts = {}) {
  const exe = cmd === 'git' ? resolveGit() : cmd
  if (!exe) return null
  try {


    return execFileSync(exe, args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  } catch {
    return null
  }
}


function listFiles() {
  return listSourceFiles(REPO, { gitBin: resolveGit() })
}


const RUST_RULES = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, 'struct'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, 'enum'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, 'trait'],
  [/^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>', ]*\s+for\s+)?([A-Za-z_]\w*)/, 'impl'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, 'mod'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)/, 'const'],
  [/^\s*macro_rules!\s*([A-Za-z_]\w*)/, 'macro'],
]
const TS_RULES = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'fn'],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'iface'],
  [/^\s*(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, 'fn'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, 'var'],

  [/^\s{2,}(?:public |private |protected |static |async |readonly |override |get |set )*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{/, 'method'],
]
const PY_RULES = [
  [/^\s*def\s+(\w+)/, 'fn'],
  [/^\s*class\s+(\w+)/, 'class'],
  [/^([A-Za-z_]\w*)\s*[:=]/, 'var'],
]
const BRANCH_RE = /\b(if|else|elif|for|while|match|case|switch|catch|except|when)\b|&&|\|\||\?\?|\?(?=[^?])/g







import { loadHubConfig, createHubModel, stripNoise, isVendorPath, hubNormTable } from './repoctx-hub.mjs'

const KEYWORDS = new Set([
  'if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'default', 'catch', 'except', 'finally',
  'return', 'do', 'try', 'match', 'when', 'new', 'await', 'yield', 'typeof', 'instanceof',
  'function', 'const', 'let', 'var', 'class', 'import', 'export', 'from', 'as', 'break', 'continue',
  'throw', 'delete', 'void', 'undefined', 'null', 'true', 'false', 'async', 'public', 'private',
])

function rulesFor(lang) {
  if (lang === 'rust') return RUST_RULES
  if (lang === 'py') return PY_RULES
  if (lang === 'md') return null
  return TS_RULES
}

function docFrom(lines, idx, lang) {
  const out = []
  for (let i = idx - 1; i >= 0 && out.length < DOC_LINES; i--) {
    const t = lines[i].trim()
    const isDoc = lang === 'md'
      ? false
      : /^(\/\/\/|\/\/!|\/\/|#|\*|\/\*\*|"""|''')/.test(t) && t.length > 1
    if (!isDoc || t === '*') break
    out.unshift(t.replace(/^(\/\/\/|\/\/!|\/\/|\/\*\*|\*|"""|''')+\s?/, '').replace(/\*\/$/, '').trim())
    if (/^\/\*\*/.test(t)) break
  }
  return out.filter(Boolean).join(' ').slice(0, 200)
}

function extractSymbols(relPath, text) {
  const lang = LANG_BY_EXT[path.extname(relPath).toLowerCase()]
  if (!lang) return []
  const lines = text.split(/\r?\n/)
  const found = []
  if (lang === 'md') {
    lines.forEach((line, i) => {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)

      if (m) found.push({ name: m[2].slice(0, 120), kind: 'sec', line: i + 1, level: m[1].length, ind: m[1].length })
    })
    return found
  }
  const rules = rulesFor(lang)
  lines.forEach((line, i) => {
    for (const [re, kind] of rules) {
      const m = re.exec(line)
      if (!m) continue
      const name = m[1]
      if (!name || name.length < 2) continue

      if (KEYWORDS.has(name)) continue
      found.push({
        name, kind, line: i + 1,
        ind: (line.match(/^\s*/) || [''])[0].length,
        sig: line.trim().slice(0, 200),
        doc: docFrom(lines, i, lang),
      })
      break
    }
  })
  return found
}


function churnMap() {
  const out = run('git', ['log', '--name-only', '--pretty=format:', '-n', '800'])
  const counts = {}
  if (!out) return counts
  for (const line of out.split('\n')) {
    const f = line.trim()
    if (f) counts[f] = (counts[f] || 0) + 1
  }
  return counts
}









let LAST_READ_ERRORS = []

function buildIndex() {
  LAST_READ_ERRORS = []
  const files = []
  const symbols = []
  const rels = listFiles().filter((rel) => INDEXED_EXT.has(path.extname(rel).toLowerCase()))




  let parallel = null
  if (ast.available && rels.length >= 64 && process.env.REPOCTX_PARALLEL !== '0') {
    const raw = run(process.execPath, [
      path.join(SKILL_DIR, 'scripts', 'repoctx-parallel.mjs'), '--repo', REPO, '--wasm', WASM_DIR,
      '--files', JSON.stringify(rels.map((rel) => ({ rel, lang: LANG_BY_EXT[path.extname(rel).toLowerCase()] }))),
    ])
    if (raw) {
      try {
        const j = JSON.parse(raw)
        if (j.ok) { parallel = j; ast.parallelMode = '并行×' + j.workers }
      } catch { }
    }
  }
  const aliases = new Map()
  const importsOf = new Map()
  const reexportsOf = new Map()
  for (const rel of rels) {
    const ext = path.extname(rel).toLowerCase()
    const abs = path.join(REPO, rel)
    let stat
    try { stat = fs.statSync(abs) } catch (e) { LAST_READ_ERRORS.push({ rel, why: String(e?.message || e) }); continue }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch (e) { LAST_READ_ERRORS.push({ rel, why: String(e?.message || e) }); continue }
    const lang = LANG_BY_EXT[ext]


    let syms = null
    if (parallel) {

      const rec = parallel.files?.[rel]
      syms = rec?.syms || null
      if (syms && rec.imports) {
        syms.imports = { names: rec.imports.names, aliases: new Map(rec.imports.aliases) }
      }
    }
    if (!syms && ast.available && lang !== 'md') {
      try { syms = ast.extract(rel, lang, text) } catch { syms = null }
    }
    if (!syms) syms = extractSymbols(rel, text)
    const fileId = files.length
    files.push({ p: rel, lang, bytes: stat.size, symbols: syms.length })

    const fileLines = text.split(/\r?\n/)




    const astImp = syms.imports
    const ali = astImp ? astImp.aliases : aliasScan(text, lang)
    if (ali.size) aliases.set(rel, ali)
    if (astImp && astImp.names.length) importsOf.set(rel, astImp.names)
    else if (!astImp) {

      const nm = [...new Set([...ali.values()])]
      if (nm.length) importsOf.set(rel, nm)
    }

    const rex = reexportScan(text, lang)
    if (rex.length) reexportsOf.set(rel, rex)
    syms.forEach((s, i) => {


      let endLine = s.endLine
      if (!endLine) {
        endLine = fileLines.length
        for (let j = i + 1; j < syms.length; j++) {
          if ((syms[j].ind ?? 0) <= (s.ind ?? 0)) { endLine = Math.max(s.line, syms[j].line - 1); break }
        }
      }
      const body = fileLines.slice(s.line - 1, endLine).join('\n').slice(0, BODY_SCAN_CHARS)



      const ind = s.ind ?? 0


      const local = s.local === true || ((s.kind === 'var' || s.kind === 'const') && ind > 0)
      symbols.push({
        p: rel, n: s.name, t: s.kind, l: s.line, el: endLine,
        sig: s.sig || s.name,
        doc: s.doc || docFrom(fileLines, s.line - 1, lang),
        f: fileId,
        cx: s.cx ?? ((body.match(BRANCH_RE) || []).length + 1),
        local,
        q: s.q,
        tr: s.tr,
        qrefs: s.qrefs,
        exp: s.exp,
        refs: s.refs || null,
        trefs: s.trefs,
        body,
      })
    })
  }





  {
    const byFile = new Map()
    symbols.forEach((s) => {
      if (!byFile.has(s.p)) byFile.set(s.p, [])
      byFile.get(s.p).push(s)
    })
    for (const arr of byFile.values()) {
      arr.sort((a, b) => a.l - b.l || (b.el ?? 0) - (a.el ?? 0))
      const stack = []
      for (const s of arr) {



        while (stack.length && (stack[stack.length - 1].el ?? Number.MAX_SAFE_INTEGER) < s.l) stack.pop()
        for (const a of stack) {
          if (s.l > a.l) a._desc = (a._desc || 0) + (s.cx || 0)
        }
        stack.push(s)
      }
      for (const s of arr) {
        s.cxOwn = Math.max(0, (s.cx || 0) - (s._desc || 0))
        delete s._desc
      }
    }
  }
  return { files, symbols, aliases, importsOf, reexportsOf }
}








function buildMap() {
  const { files, symbols, aliases, importsOf, reexportsOf } = buildIndex()
  const { edges, typeEdges, ambiguous, ambRefs, ambTypes, localOnly } = buildEdges(symbols, aliases)
  const chars = symbols.reduce((s, x) => s + x.body.length, 0)
  return {
    schema: SCHEMA,
    root: '.',
    stats: { files: files.length, symbols: symbols.length, edges: edges.length, typeEdges: typeEdges.length, ambiguous, ambTypes, localOnly, bodyChars: chars },
    churn: churnMap(),
    files,
    symbols,
    edges,

    typeEdges,

    imports: Object.fromEntries([...importsOf].sort((a, b) => a[0].localeCompare(b[0]))),

    reexports: Object.fromEntries([...reexportsOf].sort((a, b) => a[0].localeCompare(b[0]))),


    ambRefs,
  }
}


function serializable(map) {
  const { symbols, ...rest } = map
  return { ...rest, symbols: symbols.map(({ body, refs, qrefs, trefs, ...s }) => s) }
}
function appendNote(rec) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.appendFileSync(NOTES_FILE, JSON.stringify(rec) + '\n', 'utf8')
}
















const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WASM_DIR = process.env.REPOCTX_WASM_DIR || path.join(SKILL_DIR, 'node_modules', 'tree-sitter-wasms', 'out')
let ast = { available: false, reason: '未初始化' }
try {
  const mod = await import('./repoctx-ast.mjs')
  ast = await mod.createAstExtractor({ wasmDir: WASM_DIR })
} catch (e) {
  ast = { available: false, reason: e.message }
}




const numFlag = (v, d, name) => {
  if (v === undefined || v === null || v === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`✗ --${name} 需要正整数，收到：${v}`)
    process.exit(2)
  }
  return n
}
const top = numFlag(flags.top, cmd === 'tree' ? 40 : 12, 'top')
const maxTokens = numFlag(flags['max-tokens'], 6000, 'max-tokens')

switch (cmd) {
  case 'index': {
    const map = buildMap()


    if (LAST_READ_ERRORS.length) {
      console.error(`✗ 索引不完整，已放弃写入：${LAST_READ_ERRORS.length} 个源文件读取失败（Windows 上常见于杀软/索引器短暂锁文件；稍后重跑即可）`)
      for (const r of LAST_READ_ERRORS.slice(0, 5)) console.error(`    ${r.rel} — ${r.why}`)
      if (LAST_READ_ERRORS.length > 5) console.error(`    …另有 ${LAST_READ_ERRORS.length - 5} 个`)
      process.exit(1)
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(MAP_FILE, JSON.stringify(serializable(map)) + '\n', 'utf8')
    const st = map.stats
    console.log(`✓ 已索引 ${path.relative(process.cwd(), REPO) || '.'}`)
    console.log(`  文件 ${st.files} · 符号 ${st.symbols} · 边 ${st.edges} · 歧义未连 ${st.ambiguous}`
      + `${st.localOnly ? ` · 函数局部引用 ${st.localOnly}（非 API，单列不计歧义）` : ''}`)
    console.log(`  产物 ${posix(path.relative(REPO, MAP_FILE))}（${Math.round(fs.statSync(MAP_FILE).size / 1024)} KB，不含时间戳→可做 0 漂移校验）`)
    console.log(ast.available
      ? `  抽取器：AST/tree-sitter（${ast.langs.join(' ')}）`
      : `  抽取器：行级（AST 未启用，原因：${ast.reason}）`)
    break
  }
  case 'check': {
    const fresh = JSON.stringify(serializable(buildMap()))


    if (LAST_READ_ERRORS.length) {
      console.error(`✗ 无法验证索引：${LAST_READ_ERRORS.length} 个源文件读取失败（Windows 上常见于杀软/索引器短暂锁文件；稍后重跑即可）`)
      for (const r of LAST_READ_ERRORS.slice(0, 5)) console.error(`    ${r.rel} — ${r.why}`)
      process.exit(1)
    }
    const onDisk = fs.existsSync(MAP_FILE) ? fs.readFileSync(MAP_FILE, 'utf8').trim() : ''
    if (fresh !== onDisk) {
      console.error('✗ 索引已漂移：请重跑 node repoctx.mjs index')
      process.exit(1)
    }
    console.log('✓ 索引与源码一致（0 漂移）')


    const st = loadMap().stats
    const mdPath = path.join(OUT_DIR, 'MAP.md')
    const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : ''
    const m = /^> 规模：\*\*(\d+)\*\* 文件 · \*\*(\d+)\*\* 符号 · \*\*(\d+)\*\* 边 · (\d+) 处同名歧义未连边/m.exec(md)
    if (!md.trim()) console.log('⚠ MAP.md 不存在：跑一次 `repoctx export` 生成（入库供评审 diff）')
    else if (!m) console.log('⚠ MAP.md 缺少规模行（旧版格式？），建议重跑 export')
    else if (+m[1] !== st.files || +m[2] !== st.symbols || +m[3] !== st.edges || +m[4] !== st.ambiguous) {
      console.log(`⚠ MAP.md 已过期（记录 ${m[1]} 文件/${m[2]} 符号/${m[3]} 边/${m[4]} 歧义 ≠ 当前 ${st.files}/${st.symbols}/${st.edges}/${st.ambiguous}）——重跑 export`)
    } else {
      console.log('✓ MAP.md 与 map.json 同源一致')
    }





    if (!flags['no-freshness']) {
      if (!run('git', ['rev-parse', '--git-dir'])) {
        console.log('⚠ 非 git 目录：跳过 git 新鲜度检查')
      } else {
        let fail = false
        const upstream = (run('git', ['rev-parse', '--abbrev-ref', '@{upstream}']) || '').trim()
        if (!upstream) console.log('⚠ 无上游跟踪分支：跳过落后远端检查（push -u 后可用）')
        else {
          const behind = Number(run('git', ['rev-list', '--count', `HEAD..${upstream}`]) || 0)
          if (behind > 0) {
            console.error(`✗ 本地落后上游 ${upstream} ${behind} 个提交：先 git merge --ff-only ${upstream}（旧基线上的索引与结论不可信）`)
            fail = true
          } else console.log(`✓ 与上游 ${upstream} 同步`)
        }

        let main = (run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD']) || '').trim()
        main = main.startsWith('origin/') ? main : null
        if (!main) {
          for (const c of ['origin/main', 'origin/master']) {
            if (run('git', ['rev-parse', '--verify', '--quiet', `${c}^{commit}`])) { main = c; break }
          }
        }
        if (!main) console.log('⚠ 找不到 origin/HEAD 或 origin/main|master：跳过落后主分支检查')
        else {
          const behind = Number(run('git', ['rev-list', '--count', `HEAD..${main}`]) || 0)
          const ahead = Number(run('git', ['rev-list', '--count', `${main}..HEAD`]) || 0)
          const maxBehind = numFlag(flags['max-behind'], 50, 'max-behind')
          if (behind > maxBehind) {
            const msg = `本地落后 ${main} ${behind} 个提交（阈值 ${maxBehind}）`
            if (ahead > 0) {
              console.log(`⚠ ${msg}，但本地有 ${ahead} 个提交（分叉属正常）；如需最新基线请人工决定是否 rebase`)
            } else {
              console.error(`✗ ${msg}：本地 main 类分支纯过期——先 git merge --ff-only ${main}`)
              fail = true
            }
          } else {
            console.log(`✓ git 新鲜度：落后 ${main} ${behind} · 领先 ${ahead}${behind > 0 ? '（阈值内）' : ''}`)
          }
        }
        if (fail) {
          console.error('  （本检查不联网：如需最新远端状态，先 git fetch origin --prune 再重跑；--no-freshness 可关闭）')
          process.exit(1)
        }
      }
    }



    const allNotes = readNotes()
    if (allNotes.length) {
      const m1 = loadMap()
      const symNames = new Set(m1.symbols.map((s) => s.n))
      const filePaths = new Set(m1.files.map((f) => f.p))
      const drift = allNotes.filter((r) =>
        (r.sym && !symNames.has(r.sym)) || (r.file && !filePaths.has(r.file)))
      if (drift.length) {
        console.log(`⚠ 笔记漂移候选 ${drift.length} 条（绑定的符号/文件已不在索引）：repoctx notes --drift 查看；人工确认后改写（note 会追加新条）`)
      } else {
        console.log(`✓ 笔记绑定有效（${allNotes.length} 条，0 漂移候选）`)
      }
    }
    break
  }
  case 'for': {
    const map = loadMap()
    const query = positional.join(' ')



    const rows = collapseRows(map, lensFor(map, query, top * 3)).slice(0, top)
    const lines = [`<ctx task="${esc(query)}" schema="${SCHEMA}" files="${map.stats.files}" symbols="${map.stats.symbols}" edges="${map.stats.edges}" ambiguous="${map.stats.ambiguous}">`]



    const nameLower = new Set(map.symbols.map((s) => s.n.toLowerCase()))
    const noHit = [...new Set(tokenize(query))].filter((t) => !nameLower.has(t))
    if (noHit.length && rows.length) {
      lines.push(`<!-- 提示：任务词「${esc(noHit.join('、'))}」没有任何精确符号名命中，结果按子串/词频匹配排序（可能不相关）；引用前请核对，或改用符号名关键词 -->`)
    }
    if (!rows.length) {
      lines.push('<!-- 无命中：没有任何符号的名字/路径/doc/签名命中任务词（不是被预算裁掉）。改用符号名关键词，或先 index 刷新 -->')
    }

    const hubNorm = hubModelOf(map).norm



    const FOOTER_RESERVE = 16
    let used = estTokens(lines[0]) + FOOTER_RESERVE
    let shown = 0
    for (const { i, ambCount } of rows) {
      const attrs = [ambCount > 1 ? `amb="${ambCount}"` : '', `hub="${(hubNorm[i] || 0).toFixed(3)}"`].filter(Boolean).join(' ')
      const line = symLine(map, i, ' ' + attrs)
      const t = estTokens(line)
      if (used + t > maxTokens) {
        if (shown === 0) {
          lines.push(line)
          shown = 1
          lines.push(`<!-- ⚠ --max-tokens ${maxTokens} 连一条结果都放不下，已强制输出 1 条；estTokens 口径为 ASCII/4 + CJK/字（偏保守），建议放宽预算 -->`)
        }
        break
      }
      used += t
      shown++
      lines.push(line)
    }
    lines.push(`</ctx>${shown < rows.length ? `（还有 ${rows.length - shown} 条被 token 预算裁掉，--max-tokens 可放宽）` : ''}`)
    console.log(lines.join('\n'))
    break
  }
  case 'symbol':
  case 'callers':
  case 'callees':
  case 'impact': {
    const map = loadMap()
    const hits = resolveSymbol(map, positional[0])
    if (hits.length > 1 && cmd === 'symbol') {
      console.log(`“${positional[0]}”有多处定义（${hits.length}）：`)
      hits.forEach(({ s, i }) => console.log('  ' + symLine(map, i)))
      break
    }
    const { i } = hits[0]
    if (cmd === 'symbol') { console.log(symLine(map, i)); break }

    const name0 = map.symbols[i].n
    if (cmd === 'callers') {



      const set = new Set(hits.map((h) => h.i))
      const callers = callEdges(map).filter((e) => set.has(e.to))
      const multi = hits.length > 1



      const reExportedBy = Object.entries(map.reexports || {})
        .map(([f, items]) => ({ f, item: items.find((it) => it.name === name0) }))
        .filter((x) => x.item)
      console.log(`<callers of="${esc(name0)}" n="${callers.length}"${multi ? ` defs="${hits.length}"` : ''}${reExportedBy.length ? ` reExportFiles="${reExportedBy.length}"` : ''}${confNote(map, i, callers.length)}>`)
      callers.forEach((e) => console.log(symLine(map, e.from, ` prov="${e.prov}"${multi ? ` to="${esc(map.symbols[e.to].q || name0)}"` : ''}`)))
      if (reExportedBy.length) {
        console.log(`  <re-exported-by n="${reExportedBy.length}" note="以下文件 re-export 了它：这些转发**不产生名字级调用边**，callers 为 0/偏少不代表公共面小；删除前先追 barrel 路径，公共面 = 直接 callers + 这里的转发">`)
        for (const { f, item } of reExportedBy.slice(0, top)) {
          console.log(`    <f p="${esc(f)}"${item.as !== item.name ? ` as="${esc(item.as)}"` : ''}/>`)
        }
        if (reExportedBy.length > top) console.log(`    <!-- 还有 ${reExportedBy.length - top} 个 barrel 被裁掉 -->`)
        console.log('  </re-exported-by>')
      }
      console.log('</callers>')
      break
    }
    if (cmd === 'callees') {
      const idxs = calleesOf(map, i)
      const edges = callEdges(map)
      const provOf = (j) => (edges.find((e) => e.from === i && e.to === j) || {}).prov || '?'
      console.log(`<callees of="${esc(map.symbols[i].n)}" n="${idxs.length}">`)
      idxs.forEach((j) => console.log(symLine(map, j, ` prov="${provOf(j)}"`)))
      console.log('</callees>')
      break
    }
    const depth = numFlag(flags.depth, 3, 'depth')
    const withTypes = Boolean(flags.types)
    const { list: aff, viaType } = impactDetail(map, i, depth, { types: withTypes })



    const disp = dispatchOf(map)
    const dispSet = new Set()
    for (const { i: di } of hits) {
      const cands = disp.get(di)
      if (cands) for (const j of cands) if (!aff.includes(j)) dispSet.add(j)
    }
    const dispAttr = dispSet.size ? ` dispatch="${dispSet.size}"` : ''
    const typeAttr = withTypes && viaType.size ? ` viaType="${viaType.size}"` : ''
    const note = withTypes
      ? '传递闭包（in-edges **含类型引用边** --types）：类型引用是**过近似**——只有字段/参数/返回类型改动时才真会波及它们（只改类型内部实现则无感），故逐条标 via="type"'
      : '传递闭包（in-edges），= 改动爆炸半径；--types 可额外纳入类型引用边（类型改动半径）'
    console.log(`<impact of="${esc(name0)}" depth="${depth}" n="${aff.length}"${dispAttr}${typeAttr} note="${note}"${confNote(map, i, aff.length)}>`)
    aff.slice(0, top).forEach((j) => console.log(symLine(map, j, viaType.has(j) ? ' via="type"' : '')))
    if (aff.length > top) console.log(`<!-- 还有 ${aff.length - top} 个受影响符号被裁掉 -->`)
    if (dispSet.size) {
      console.log(`<dispatch n="${dispSet.size}" note="动态派发候选集（过近似）：以下 impl 实现会随 trait 方法签名改动而波及；不进精确调用图（宁缺毋滥），callers 口径不变">`)
      for (const j of [...dispSet].sort((a, b) => map.symbols[a].p.localeCompare(map.symbols[b].p) || map.symbols[a].l - map.symbols[b].l)) {
        console.log('  ' + symLine(map, j, ' prov="dispatch"'))
      }
      console.log('</dispatch>')
    }
    console.log('</impact>')
    break
  }
  case 'affected': {




    const map = loadMap()


    let files = String(flags.files || '').split(',').map((x) => x.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean)
    let baseRev = null
    if (flags.diff) {



      const rev = flags.diff === true ? 'origin/HEAD' : String(flags.diff)
      baseRev = (run('git', ['merge-base', rev, 'HEAD']) || run('git', ['rev-parse', rev]) || '').trim() || null
      const out = baseRev ? run('git', ['diff', '--name-only', baseRev]) : null
      if (out === null) { console.error(`✗ 取 git 改动失败（--diff ${rev}）——git 不可用或基准版本不存在；也可直接用 --files a,b`); process.exit(2) }
      files = files.concat(out.split('\n').map((x) => x.trim()).filter(Boolean))
    }
    files = [...new Set(files)]
    if (!files.length) { console.error('用法：repoctx affected --files a.rs,b.ts [--depth N] 或 affected --diff [rev]'); process.exit(2) }
    const set = new Set(files)
    const seeds = map.symbols.map((s, i) => ({ s, i })).filter(({ s }) => set.has(s.p))
    const depth = numFlag(flags.depth, 2, 'depth')
    const aff = new Set()
    const withTypes = Boolean(flags.types)
    const viaTypeAll = new Set()
    for (const { i } of seeds) {
      const d = impactDetail(map, i, depth, { types: withTypes })
      for (const j of d.list) aff.add(j)
      for (const j of d.viaType) viaTypeAll.add(j)
    }
    for (const { i } of seeds) aff.delete(i)
    const typeAttr = withTypes && viaTypeAll.size ? ` viaType="${viaTypeAll.size}"` : ''
    console.log(`<affected files="${files.length}" seeds="${seeds.length}" affected="${aff.size}" depth="${depth}"${typeAttr}${baseRev ? ` base="${baseRev.slice(0, 8)}"` : ''} note="改动文件内符号（seed）+ 其 in-edges 闭包并集${withTypes ? '（--types：含类型引用边，过近似）' : ''}；conf 口径同 impact">`)
    for (const { s, i } of seeds.slice(0, top)) console.log('  ' + symLine(map, i, ' seed="1"'))
    if (seeds.length > top) console.log(`<!-- seeds 还有 ${seeds.length - top} 个被裁掉 -->`)
    const ordered = [...aff].sort((a, b) => map.symbols[a].p.localeCompare(map.symbols[b].p) || map.symbols[a].l - map.symbols[b].l)
    for (const i of ordered.slice(0, top)) console.log('  ' + symLine(map, i))
    if (ordered.length > top) console.log(`<!-- 受影响符号还有 ${ordered.length - top} 个被裁掉（--top 调大） -->`)
    console.log('</affected>')
    break
  }
  case 'tree': {
    const map = loadMap()
    const rank = pagerankOf(map)
    const byFile = new Map()
    map.symbols.forEach((s, i) => {
      if (!byFile.has(s.p)) byFile.set(s.p, [])
      byFile.get(s.p).push({ s, i, r: rank[i] })
    })
    const files = [...byFile.entries()]
      .map(([p, list]) => ({ p, list, best: Math.max(...list.map((x) => x.r)) }))
      .sort((a, b) => b.best - a.best)
      .slice(0, top)
    for (const f of files) {
      console.log(`<f p="${esc(f.p)}" symbols="${f.list.length}">`)
      f.list.sort((a, b) => b.r - a.r).slice(0, 8).forEach(({ s, i }) => console.log('  ' + symLine(map, i)))
      console.log('</f>')
    }
    break
  }
  case 'note': {






    const text = flags.text || positional.join(' ')
    if (!text) {
      console.error('✗ 用法：repoctx note --sym NAME --text "..." [--file PATH] [--tags a,b] [--kind pitfall] [--alias 别名1,alias2] [--rel SYM1,SYM2] [--id my-note-id]')
      process.exit(2)
    }
    const rec = {
      at: new Date().toISOString().slice(0, 10),
      id: flags.id ? String(flags.id) : undefined,
      kind: flags.kind ? String(flags.kind).trim() : undefined,
      sym: flags.sym || null,
      file: flags.file || null,
      aliases: flags.alias ? String(flags.alias).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      rel: flags.rel ? String(flags.rel).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
      tags: flags.tags ? String(flags.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
      note: text,
    }
    if (rec.aliases && !rec.aliases.length) delete rec.aliases
    if (rec.rel && !rec.rel.length) delete rec.rel
    appendNote(rec)
    const bind = rec.sym ? `符号 ${rec.sym}` : rec.file ? `文件 ${rec.file}` : '仓库'
    const relN = rec.rel?.length ? ` · 一跳关系 ${rec.rel.length} 个` : ''
    const aliasN = rec.aliases?.length ? ` · 别名 ${rec.aliases.length} 个` : ''
    console.log(`✓ 已记录${rec.kind ? `（${rec.kind}）` : ''}并绑定到${bind}${relN}${aliasN}（${posix(path.relative(REPO, NOTES_FILE))}）`)
    break
  }
  case 'notes': {

    if (flags.drift) {
      const mapD = loadMap()
      const symNames = new Set(mapD.symbols.map((s) => s.n))
      const filePaths = new Set(mapD.files.map((f) => f.p))
      const rows = readNotes().filter((r) =>
        (r.sym && !symNames.has(r.sym)) || (r.file && !filePaths.has(r.file)))
      console.log(`<drift n="${rows.length}" note="绑定的符号/文件已不在索引（重命名/删除？）；笔记是**人写经验不可重建**——人工确认后用 note 追加改写版（旧条保留作历史），不要手改 jsonl">`)
      for (const r of rows) {
        const bind = r.sym ? `sym="${esc(r.sym)}"` : `file="${esc(r.file)}"`
        console.log(`  <note at="${r.at}" ${bind}${r.id ? ` id="${esc(r.id)}"` : ''}>${esc(r.note)}</note>`)
      }
      console.log('</drift>')
      break
    }
    const rows = readNotes().filter((r) =>
      (!flags.sym || r.sym === flags.sym || (Array.isArray(r.rel) && r.rel.includes(String(flags.sym)))) &&
      (!flags.file || r.file === flags.file) &&
      (!flags.kind || r.kind === String(flags.kind)) &&
      (!flags.contains || (r.note || '').includes(String(flags.contains))))
    if (!rows.length) { console.log('（没有匹配的笔记）'); break }
    for (const r of rows) {
      const bind = r.sym ? `[${r.sym}]` : r.file ? `[${r.file}]` : '[repo]'
      const kind = r.kind ? `<${r.kind}>` : ''
      const tags = r.tags?.length ? ` (${r.tags.join(',')})` : ''
      const rel = Array.isArray(r.rel) && r.rel.length ? ` →${r.rel.join(',')}` : ''
      const alias = Array.isArray(r.aliases) && r.aliases.length ? ` ≈${r.aliases.join(',')}` : ''
      console.log(`${r.at}  ${bind}${kind}${tags}${rel}${alias}  ${r.note}`)
    }
    break
  }
  case 'context': {

    const map = loadMap()
    const hits = resolveSymbol(map, positional[0])
    const { s, i } = hits[0]


    const defSet = new Set(hits.map((h) => h.i))
    const callers = callEdges(map).filter((e) => defSet.has(e.to))
    const docs = map.edges.filter((e) => defSet.has(e.to) && e.prov === 'doc').map((e) => e.from)
    const depth = numFlag(flags.depth, 2, 'depth')
    const withTypes = Boolean(flags.types)
    const affSet = new Set()
    const viaTypeAll = new Set()
    for (const hi of defSet) {
      const d = impactDetail(map, hi, depth, { types: withTypes })
      for (const j of d.list) affSet.add(j)
      for (const j of d.viaType) viaTypeAll.add(j)
    }
    const aff = [...affSet]



    const typeEdges = map.typeEdges || []
    const typeIn = typeEdges.filter((e) => defSet.has(e.to))
    const typeOut = typeEdges.filter((e) => defSet.has(e.from))
    const importFiles = Object.entries(map.imports || {}).filter(([, names]) => names.includes(s.n)).map(([f]) => f)


    const notes = readNotes().filter((r) => r.sym === s.n || (r.file && r.file === s.p)
      || (Array.isArray(r.rel) && r.rel.includes(s.n))
      || (Array.isArray(r.aliases) && r.aliases.includes(s.n)))
    const boundBy = (r) => (r.sym === s.n ? 'sym' : r.file === s.p ? 'file' : Array.isArray(r.rel) && r.rel.includes(s.n) ? 'rel' : 'alias')


    console.log(`<context sym="${esc(s.n)}" t="${s.t}" p="${esc(s.p)}" l="${s.l}" cx="${s.cx}"${confNote(map, i, callers.length)}>`)
    if (s.doc) console.log(`  <doc>${esc(s.doc)}</doc>`)
    if (notes.length) {
      console.log(`  <notes n="${notes.length}" src=".repoctx/notes.jsonl">`)
      for (const r of notes) {
        const kind = r.kind ? ` kind="${esc(r.kind)}"` : ''
        const rel = Array.isArray(r.rel) && r.rel.length ? ` rel="${esc(r.rel.join(','))}"` : ''
        const alias = Array.isArray(r.aliases) && r.aliases.length ? ` aliases="${esc(r.aliases.join(','))}"` : ''
        console.log(`    <note at="${r.at}" bound-by="${boundBy(r)}"${kind}${rel}${alias}>${esc(r.note)}</note>`)
      }
      console.log('  </notes>')
    }
    console.log(`  <callers n="${callers.length}">`)
    for (const e of callers) console.log('    ' + symLine(map, e.from, ` prov="${e.prov}"`))
    console.log('  </callers>')
    console.log(`  <impact n="${aff.length}" depth="${depth}"${viaTypeAll.size ? ` viaType="${viaTypeAll.size}"` : ''}>`)
    aff.slice(0, top).forEach((j) => console.log('    ' + symLine(map, j, viaTypeAll.has(j) ? ' via="type"' : '')))
    console.log('  </impact>')
    if (typeIn.length || typeOut.length) {
      console.log(`  <typerefs in="${typeIn.length}" out="${typeOut.length}" note="类型引用族（trefs→typeEdges，零推断）：in = 谁在**类型位**引用了它（改这个类型 → 波及它们）；out = 它引用了哪些类型。**不进调用图**——类型引用不是调用">`)
      if (typeIn.length) {
        console.log(`    <in n="${typeIn.length}">`)
        for (const e of typeIn.slice(0, 8)) console.log('      ' + symLine(map, e.from))
        if (typeIn.length > 8) console.log(`      <!-- 还有 ${typeIn.length - 8} 条被裁掉 -->`)
        console.log('    </in>')
      }
      if (typeOut.length) {
        console.log(`    <out n="${typeOut.length}">`)
        for (const e of typeOut.slice(0, 8)) console.log('      ' + symLine(map, e.to))
        if (typeOut.length > 8) console.log(`      <!-- 还有 ${typeOut.length - 8} 条被裁掉 -->`)
        console.log('    </out>')
      }
      console.log('  </typerefs>')
    }
    if (importFiles.length) {
      console.log(`  <imports n="${importFiles.length}" note="哪些文件导入了这个符号（AST 导入绑定，零推断；同名多定义时不判断具体指向哪一个）">`)
      for (const f of importFiles.slice(0, 8)) console.log(`    <f p="${esc(f)}"/>`)
      if (importFiles.length > 8) console.log(`    <!-- 还有 ${importFiles.length - 8} 个文件被裁掉 -->`)
      console.log('  </imports>')
    }
    if (docs.length) {
      console.log(`  <docs n="${docs.length}" note="文档里提到它的位置（prov=doc；含 doc/rules/*.md 时即规则知识入口）">`)
      for (const j of docs.slice(0, 8)) {
        console.log(`    <d p="${esc(map.symbols[j].p)}" l="${map.symbols[j].l}">${esc(map.symbols[j].n)}</d>`)
      }
      console.log('  </docs>')
    }
    console.log('</context>')
    break
  }
  case 'export': {

    const map = loadMap()
    const rank = pagerankOf(map)
    const notes = readNotes()
    const outFile = flags.out ? path.resolve(String(flags.out)) : path.join(OUT_DIR, 'MAP.md')
    const L = []
    L.push('# 仓库地图（repoctx 自动生成，请勿手改）')
    L.push('')
    L.push(`> 由 \`repoctx export\` 从 \`.repoctx/map.json\` + \`.repoctx/notes.jsonl\` 生成（改知识请改源，不要改本文件）。`)
    L.push(`> 规模：**${map.stats.files}** 文件 · **${map.stats.symbols}** 符号 · **${map.stats.edges}** 边 · ${map.stats.ambiguous} 处同名歧义未连边。`)
    L.push(`> 抽取器：**${ast.available ? 'AST/tree-sitter' : '行级（AST 未启用）'}**；边的 ` + '`prov`' + ` 语义：\`name\`=全局唯一名匹配、\`same-file\`、\`doc\`=文档提及（不计入调用图）。`)
    L.push('')



    const { model: hubModel, cfg: hubCfg } = hubModelOf(map)
    const hubRows = hubModel.collapse(hubModel.ranking(top * 3)).slice(0, top)
    L.push(`## 枢纽符号（多特征加权，共 ${hubRows.length} 条）`)
    L.push('')
    L.push('> 打分：`归一化入度 × 类型权重 × 路径权重 × 泛用名系数 × 跨度 × 跨文件广度`。')
    L.push(`> 泛用名（\`push\`/\`len\`/\`json\`…）**降权不删除**（系数 ${hubCfg.genericDamp}）；测试路径 ×${hubCfg.testDamp}；同文件引用 ×0.7。`)
    L.push(`> **局部变量与第三方路径不进候选**。想恢复某个同名符号的权重，把它加进 \`.repoctx/config.json\` 的 \`hub.whitelist\`（当前：${(hubCfg.whitelist || []).join(', ') || '空'}）。`)
    L.push('')
    L.push('| 符号（限定名） | 类型 | 位置 | 得分 | 归一化入度 | 同名 | 因子(类型/路径/名/跨度/广度) | cx |')
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const h of hubRows) {

      const label = h.s.q || h.s.n
      L.push(`| \`${label}\` | ${h.s.t} | \`${h.s.p}:${h.s.l}\` | ${h.score.toFixed(4)} | ${h.norm.toFixed(2)} | ${h.ambCount > 1 ? h.amb : 1} | ${h.k}/${h.pw}/${h.nw}/${h.sw}/${h.bw} | ${h.s.cx} |`)
    }
    L.push('')




    const { code: groups, hidden: docsHidden } = codeAmbGroups(map)
    L.push(`## 歧义组（同名定义 >1 的**代码名**，共 ${groups.length} 组；只列被引用最多的 ${Math.min(top, groups.length)} 组）`)
    L.push('')
    if (!groups.length) {
      L.push('（无）')
    } else {
      L.push('| 名字 | 定义数 | 被引用(歧义) | 代表位置 |')
      L.push('| --- | --- | --- | --- |')
      for (const g of groups.slice(0, top)) {
        const rep = map.symbols[g.idxs[0]]
        const docN = docCountOf(map, g)
        const tag = docN ? `（含 doc×${docN}）` : ''
        L.push(`| \`${g.name}\`${tag} | ${g.idxs.length} | ${g.refs} | \`${rep.p}:${rep.l}\` |`)
      }
      L.push('')
      L.push('> 展开某组：`repoctx amb <名字>`。这些同名引用**没有连边**，是本地精度受限的主要来源。')
      L.push(`> 另有 ${docsHidden} 组是**纯文档段落**（md 标题之间的撞名，与代码无关）→ 默认不列；\`repoctx amb --docs\` 可见。`)
    }
    L.push('')


    const byFile = new Map()
    map.symbols.forEach((s, i) => {
      if (!byFile.has(s.p)) byFile.set(s.p, [])
      byFile.get(s.p).push({ s, i, r: rank[i] || 0 })
    })
    const files = [...byFile.entries()]
      .map(([p, list]) => ({ p, list, best: Math.max(...list.map((x) => x.r)) }))
      .sort((a, b) => b.best - a.best)
      .slice(0, top)
    L.push(`## 文件地图（按重要度，前 ${files.length}）`)
    L.push('')
    for (const f of files) {
      const syms = f.list.sort((a, b) => b.r - a.r).slice(0, 6)
      L.push(`### \`${f.p}\`（${f.list.length} 符号）`)
      L.push('')
      for (const { s } of syms) L.push(`- \`${s.n}\` — ${s.t} @L${s.l}（cx ${s.cx}）${s.doc ? ` · ${s.doc.slice(0, 80)}` : ''}`)
      L.push('')
    }


    L.push(`## 记忆（人写笔记，共 ${notes.length} 条，源：\`.repoctx/notes.jsonl\`）`)
    L.push('')
    if (!notes.length) {
      L.push('（暂无。用 `repoctx note --sym NAME --text "…"` 记录踩过的坑与决定。）')
    } else {
      for (const n of notes) {
        const bind = n.sym ? `\`${n.sym}\`` : n.file ? `\`${n.file}\`` : '（仓库级）'
        const tags = n.tags?.length ? `　` + n.tags.map((t) => `\`${t}\``).join(' ') : ''
        L.push(`- **${n.at}** ${bind}${tags}　${n.note}`)
      }
    }
    L.push('')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, L.join('\n'), 'utf8')
    console.log(`✓ 已生成 ${posix(path.relative(REPO, outFile))}（${Math.round(fs.statSync(outFile).size / 1024)} KB）`)
    break
  }
  case 'files': {





    const map = loadMap()
    const by = String(flags.by || 'size')
    if (!['size', 'syms', 'cx', 'dupes'].includes(by)) {
      console.error(`✗ 未知 --by=${by}（可选 size | syms | cx | dupes）`)
      process.exit(2)
    }


    if (by === 'dupes') {
      const groups = new Map()
      map.files.forEach((f) => {
        const name = f.p.split('/').pop()
        if (!groups.has(name)) groups.set(name, [])
        groups.get(name).push(f)
      })
      const dupeGroups = [...groups.entries()]
        .filter(([, arr]) => arr.length > 1)
        .map(([name, arr]) => ({ name, arr }))
        .sort((a, b) => b.arr.length - a.arr.length || a.name.localeCompare(b.name))
      console.log(`<dupes groups="${dupeGroups.length}" note="同名文件分组（同名 ≠ 副本，需人工按内容与职责判断）；按份数降序">`)
      for (const g of dupeGroups.slice(0, top)) {
        console.log(`  <d name="${esc(g.name)}" copies="${g.arr.length}">`)
        for (const f of g.arr.slice(0, 6)) {
          console.log(`    <f p="${esc(f.p)}" bytes="${f.bytes}" syms="${f.symbols}"/>`)
        }
        if (g.arr.length > 6) console.log(`    <!-- 另有 ${g.arr.length - 6} 份 -->`)
        console.log('  </d>')
      }
      console.log('</dupes>')
      break
    }
    const dir = flags.dir ? String(flags.dir).replace(/^\.\//, '').replace(/\/$/, '') : null
    const cxByFile = new Map()
    map.symbols.forEach((s) => {
      const cur = cxByFile.get(s.p) || { max: 0, sum: 0, top: null }
      const cx = s.cx || 0
      cur.sum += cx
      if (cx > cur.max) { cur.max = cx; cur.top = s }
      cxByFile.set(s.p, cur)
    })
    const rows = map.files
      .filter((f) => !dir || f.p.startsWith(dir + '/') || f.p === dir)
      .map((f) => {
        const c = cxByFile.get(f.p) || { max: 0, sum: 0, top: null }
        return { ...f, cxMax: c.max, cxSum: c.sum, top: c.top }
      })
    const key = by === 'size' ? (r) => r.bytes : by === 'syms' ? (r) => r.symbols : (r) => r.cxMax
    rows.sort((a, b) => key(b) - key(a) || b.cxSum - a.cxSum || a.p.localeCompare(b.p))
    const shown = rows.slice(0, top)
    console.log(`<files by="${by}" n="${shown.length}" total="${rows.length}"${dir ? ` dir="${dir}"` : ''} note="文件级度量（纯读产物、零新解析）：--by size|syms|cx，--dir PREFIX 限定子树；cxMax/cxSum 是**符号 span 内**的分支数（含嵌套定义——页面组件这类容器符号会偏高，别当作单个函数复杂度）">`)
    for (const r of shown) {
      const t = r.top && r.cxMax > 0 ? ` top="${esc(r.top.q || r.top.n)}"` : ''
      console.log(`  <f p="${esc(r.p)}" lang="${r.lang}" bytes="${r.bytes}" syms="${r.symbols}" cxMax="${r.cxMax}" cxSum="${r.cxSum}"${t}/>`)
    }
    console.log('</files>')
    break
  }
  case 'hubs': {

    const map = loadMap()
    const { model, cfg } = hubModelOf(map)
    const rows = model.ranking(numFlag(flags.top, 25, 'top'))
    const explain = Boolean(flags.explain)
    const groups = ambGroupsOf(map)
    console.log(`<hubs n="${rows.length}" formula="归一化入度×类型×路径×泛用名×跨度×跨文件广度"`
      + ` config="${cfg.source ? esc(posix(path.relative(REPO, cfg.source))) : '(默认)'}"`
      + `${cfg.error ? ` config_error="${esc(cfg.error)}"` : ''}`
      + ` whitelist="${esc((cfg.whitelist || []).join(',') || '-')}" genericDamp="${cfg.genericDamp}" testDamp="${cfg.testDamp}"`
      + ` ambGroups="${groups.length}" note="泛用名降权不删除；局部变量与第三方路径不进候选">`)
    rows.forEach((r, n) => {
      const ambTag = r.amb > 1 ? ` amb="${r.amb}"` : ''

      const qTag = r.s.q ? ` q="${esc(r.s.q)}"` : ''
      const factors = explain
        ? `<factors norm="${r.norm.toFixed(3)}" kind="${r.k}" path="${r.pw}" name="${r.nw}" span="${r.sw}" breadth="${r.bw}" callers="${r.callers}" callerFiles="${r.callerFiles}" tags="${esc(r.tags.join('|'))}"/>`
        : ''
      console.log(`<h rank="${n + 1}" n="${esc(r.s.n)}"${qTag} t="${r.s.t}" p="${esc(r.s.p)}" l="${r.s.l}" score="${r.score.toFixed(4)}"${ambTag} cx="${r.s.cx}">${factors}</h>`)
    })
    console.log('</hubs>')
    break
  }
  case 'impls': {





    const map = loadMap()
    const name = positional[0]
    if (!name) { console.error('用法：repoctx impls <TRAIT|TYPE>   # trait → 它的实现；类型 → 它实现的 trait'); process.exit(2) }
    const syms = map.symbols
    const fwd = syms.map((s, i) => ({ s, i })).filter(({ s }) => s.t === 'impl' && s.tr === name)
    const rev = syms.map((s, i) => ({ s, i })).filter(({ s }) => s.t === 'impl' && s.n === name)
    const isTrait = syms.some((s) => s.t === 'trait' && s.n === name)
    const total = new Set([...fwd, ...rev].map((x) => x.i)).size
    if (!total) {
      console.error(`✗ 没有与「${name}」相关的 impl（既不是项目内 trait，也没有同名类型的 impl）。`)
      process.exit(3)
    }
    console.log(`<impls n="${esc(name)}" kind="${isTrait ? 'trait' : (rev.length ? 'type' : 'external-trait')}" impls="${total}" note="Rust impl Trait for Type 静态表（AST 模式、零推断）；trait 名按字符串匹配，外部 trait 的项目内实现也能查到">`)
    for (const { s, i } of fwd) console.log('  ' + symLine(map, i, ` for="${esc(s.n)}"`))
    for (const { s, i } of rev) console.log('  ' + symLine(map, i, s.tr ? ` implements="${esc(s.tr)}"` : ' inherent="1"'))
    if (isTrait) {

      const disp = dispatchOf(map)
      for (let i = 0; i < syms.length; i++) {
        const s = syms[i]
        if ((s.t !== 'fn' && s.t !== 'method') || s.q !== `${name}::${s.n}`) continue
        console.log(`  <m name="${s.n}" providers="${disp.get(i)?.size || 0}" l="${s.l}" p="${s.p}"/>`)
      }
    }
    console.log('</impls>')
    break
  }
  case 'typerefs': {





    const map = loadMap()
    const name = positional[0]
    if (!name) { console.error('用法：repoctx typerefs <TYPE|SYMBOL>   # 类型 → 谁引用了它；符号 → 它引用了哪些类型'); process.exit(2) }
    const syms = map.symbols
    const defs = syms.map((s, i) => ({ s, i })).filter(({ s }) => s.n === name)
    if (!defs.length) { console.error(`✗ 找不到符号「${name}」（可先用 repoctx symbol ${name} 确认）`); process.exit(3) }
    const te = map.typeEdges || []
    const inEdges = te.filter((e) => defs.some((x) => x.i === e.to))
    const outEdges = te.filter((e) => defs.some((x) => x.i === e.from))
    console.log(`<typerefs n="${esc(name)}" defs="${defs.length}" inEdges="${inEdges.length}" outEdges="${outEdges.length}" note="类型引用族（trefs → typeEdges）：类型位上的类型名 × 类型定义唯一解析；零推断，且**不进调用图**（类型引用不是调用）">`)
    for (const { s, i } of defs) console.log('  ' + symLine(map, i, ' def="1"'))
    if (inEdges.length) {
      console.log(`  <in n="${inEdges.length}" note="以下符号在类型位引用了它（改这个类型的定义 → 波及它们）">`)
      for (const e of inEdges.slice(0, top)) console.log('    ' + symLine(map, e.from))
      if (inEdges.length > top) console.log(`    <!-- 还有 ${inEdges.length - top} 条被裁掉 -->`)
      console.log('  </in>')
    }
    if (outEdges.length) {
      console.log(`  <out n="${outEdges.length}" note="它（的类型位）引用的类型">`)
      for (const e of outEdges.slice(0, top)) console.log('    ' + symLine(map, e.to))
      if (outEdges.length > top) console.log(`    <!-- 还有 ${outEdges.length - top} 条被裁掉 -->`)
      console.log('  </out>')
    }
    if (!inEdges.length && !outEdges.length) {
      console.error('（没有解析到类型边：同名类型定义可能不唯一，或该名字出现在类型位但仓库内无对应类型定义）')
    }
    console.log('</typerefs>')
    break
  }
  case 'imports': {




    const map = loadMap()
    const name = positional[0]
    if (!name) { console.error('用法：repoctx imports <NAME>   # 哪些文件导入了这个符号（依赖面）'); process.exit(2) }
    const importMap = map.imports || {}
    const files = Object.entries(importMap).filter(([, names]) => names.includes(name)).map(([f]) => f).sort()
    const syms = map.symbols
    const defs = syms.map((s, i) => ({ s, i })).filter(({ s }) => s.n === name)
    console.log(`<imports n="${esc(name)}" files="${files.length}" defs="${defs.length}" note="源码显式 import/use 绑定（AST 提取、零推断）；同名多定义时不判断具体指向哪一个">`)
    for (const { s, i } of defs.slice(0, top)) console.log('  ' + symLine(map, i, ' def="1"'))
    for (const f of files) console.log(`  <f p="${esc(f)}"/>`)
    if (!files.length) console.error(`（没有任何文件导入「${name}」——注意：glob 导入（import * as ns / use x::*）不产生绑定）`)
    console.log('</imports>')
    break
  }
  case 'policy': {






    const map = loadMap()
    const policyPath = flags.policy ? path.resolve(String(flags.policy)) : path.join(REPO, '.repoctx', 'policy.yaml')
    if (!fs.existsSync(policyPath)) {
      console.error(`✗ 找不到策略文件：${posix(path.relative(REPO, policyPath))}`)
      console.error('  在仓库根创建 .repoctx/policy.yaml（入库、可 diff、可评审）。最小模板：')
      for (const line of POLICY_TEMPLATE.trimEnd().split('\n')) console.error('  │ ' + line)
      process.exit(2)
    }
    const policy = parsePolicy(fs.readFileSync(policyPath, 'utf8'))
    const structErrs = validatePolicy(policy)
    if (structErrs.length) {
      console.error('✗ policy.yaml 结构错误（检查器拒绝猜测）：')
      for (const e of structErrs) console.error(`  · ${e}`)
      process.exit(2)
    }
    const baselinePath = path.join(OUT_DIR, 'baseline.json')
    let baseline = { version: 1, violations: [] }
    if (fs.existsSync(baselinePath)) {
      try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) } catch {  }
    }
    const result = runPolicyCheck(map, policy, baseline)

    if (flags['baseline-update']) {

      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, violations: result.violations }, null, 2) + '\n', 'utf8')
      console.log(`✓ baseline 已更新：${result.violations.length} 条违规入账（${posix(path.relative(REPO, baselinePath))}，入库供评审 diff）`)
      process.exit(0)
    }

    const managed = policy.modules.filter((m) => m.managed).length
    const head = `<policy source="${esc(posix(path.relative(REPO, policyPath)))}" modules="${policy.modules.length}" managed="${managed}" violations="${result.violations.length}" baseline="${result.baselineCount}" new="${result.newViolations.length}" unmappedEdges="${result.stats.unmappedEdges}" depPairs="${result.stats.depPairs}"`
      + ` note="跨模块边 = 调用图(非doc) + imports 绑定中名字唯一的引用（同名歧义跳过，宁缺毋滥）；module-dependency/deep-import 只对 managed 模块强制；unmappedEdges = 起止任一方不在任何模块根内的边数（披露，不违规）"`
      + `${result.stats.unmappedEdges > policy.modules.length ? ' warn="大量边落在模块根之外：检查 roots 是否漏了整个目录"' : ''}>`
    const lines = [head]
    for (const v of result.newViolations) {
      lines.push(`  <v rule="${v.rule}" file="${esc(v.file)}" fp="${v.fp}"${v.module ? ` module="${esc(v.module)}"` : ''}>${esc(v.detail)}</v>`)
    }
    if (result.baselineCount > 0) {
      lines.push(`  <!-- ${result.baselineCount} 条存量违规由 baseline 认账（只拦新增）；--all 可列出 -->`)
    }
    if (flags.all && result.baselineCount > 0) {
      const accounted = new Set((baseline.violations || []).map((v) => v.fp))
      for (const v of result.violations.filter((x) => accounted.has(x.fp))) {
        lines.push(`  <b rule="${v.rule}" file="${esc(v.file)}" fp="${v.fp}"${v.module ? ` module="${esc(v.module)}"` : ''}>${esc(v.detail)}</b>`)
      }
    }
    lines.push('</policy>')
    console.log(lines.join('\n'))
    process.exit(result.newViolations.length > 0 ? 1 : 0)
  }
  case 'amb': {



    const map = loadMap()
    const { all: groups, code: codeGroups, hidden } = codeAmbGroups(map)
    const target = positional[0]
    if (target) {
      const g = groups.find((x) => x.name === target)
      if (!g) {
        console.error(`✗ 「${target}」不是歧义名（同名定义不足 2 处）。用 repoctx amb 看全部歧义组。`)
        process.exit(3)
      }



      const implN = g.idxs.filter((i) => map.symbols[i].t === 'impl').length
      const implAttr = implN ? ` impls="${implN}"` : ''
      const implNote = implN
        ? `；其中 ${implN} 条是同一类型的 impl 块（impl 名字取自类型，不是重复定义；候选集里已排除，in=0 可辨）`
        : ''
      const docN = docCountOf(map, g)
      const docAttr = docN ? ` doc="${docN}"` : ''
      const docNote = docN === 0
        ? ''
        : docN === g.idxs.length
          ? `；注意：该组 ${docN} 个定义**全部来自文档段落**（md 标题），属文档撞名、不是代码歧义`
          : `；其中 ${docN} 个定义来自文档段落（md 标题，t=sec）`
      console.log(`<amb n="${esc(g.name)}" defs="${g.idxs.length}"${implAttr}${docAttr} refs="${g.refs}" note="${esc(`同名多处定义 → 引用不连边（宁缺毋滥）；以下为全部候选${implNote}${docNote}`)}">`)


      const inDeg = new Map()
      for (const e of callEdges(map)) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1)
      const ordered = [...g.idxs].sort((a, b) =>
        (inDeg.get(b) || 0) - (inDeg.get(a) || 0)
        || map.symbols[a].p.localeCompare(map.symbols[b].p)
        || map.symbols[a].l - map.symbols[b].l)
      for (const i of ordered) {
        console.log('  ' + symLine(map, i, isVendorPath(map.symbols[i].p) ? ' vendor="1"' : ''))
      }
      console.log('</amb>')
      break
    }
    const shownGroups = flags.docs ? groups : codeGroups
    const liveGroups = shownGroups.filter((g) => g.refs > 0)
    console.log(`<amb groups="${shownGroups.length}" live="${liveGroups.length}" defs="${shownGroups.reduce((n, g) => n + g.idxs.length, 0)}"`
      + ` docsHidden="${flags.docs ? 0 : hidden}"${flags.docs ? ' docs="1"' : ''}`
      + ` note="按被引用次数排序（只列 refs>0 的活跃组）；展开单组：amb NAME；文档段落（md 标题）与代码名撞名不算代码歧义 → 纯文档组默认隐藏（--docs 显示）">`)
    for (const g of liveGroups.slice(0, numFlag(flags.top, 20, 'top'))) {
      const rep = map.symbols[g.idxs[0]]
      const implN = g.idxs.filter((i) => map.symbols[i].t === 'impl').length
      const docN = docCountOf(map, g)
      console.log(`  <g n="${esc(g.name)}" defs="${g.idxs.length}"${implN ? ` impls="${implN}"` : ''}${docN ? ` doc="${docN}"` : ''} refs="${g.refs}" rep="${esc(rep.p)}:${rep.l}"/>`)
    }
    console.log('</amb>')
    break
  }
  case 'pipeline': {





    const t = () => Number(process.hrtime.bigint() / 1000000n)
    const t0 = t()


    const { files, symbols, aliases, importsOf } = buildIndex()
    const t1 = t()





    const { edges, typeEdges, ambiguous, ambRefs, ambTypes, localOnly } = buildEdges(symbols, aliases)
    const churn = churnMap()
    const t2 = t()


    const cfg = loadHubConfig(OUT_DIR)
    const model = createHubModel({ symbols, edges, config: cfg })
    const scored = model.ranking()
    const { max } = hubNormTable(scored, symbols.length)
    const t3 = t()


    const groups = model.ambGroups(ambRefs)
    const collapsed = model.collapse(scored)
    const t4 = t()


    const notes = readNotes()
    const t5 = t()

    console.log(`<pipeline schema="${SCHEMA}" note="五阶段；不落中间缓存（map.json 为唯一权威源，--out 可导出派生视图）">`)
    console.log(`  <phase n="1" name="抽取骨架" mode="${ast.available ? 'AST/tree-sitter' : '行级（AST 未启用）'}" files="${files.length}" symbols="${symbols.length}" ms="${t1 - t0}"/>`)
    console.log(`  <phase n="2" name="名字级调用图" edges="${edges.length}" typeEdges="${typeEdges.length}" ambiguous="${ambiguous}" ambTypes="${ambTypes}" churnFiles="${Object.keys(churn).length}" ms="${t2 - t1}"/>`)
    console.log(`  <phase n="3" name="分层漏斗打分" scored="${scored.length}" maxScore="${max.toFixed(1)}" ms="${t3 - t2}"/>`)
    console.log(`  <phase n="4" name="歧义聚合+组内择优" groups="${groups.length}" defs="${groups.reduce((n, g) => n + g.idxs.length, 0)}" representatives="${collapsed.length}" ms="${t4 - t3}"/>`)
    console.log(`  <phase n="5" name="输出（笔记/配置）" notes="${notes.length}" whitelist="${(cfg.whitelist || []).join(',') || '-'}" ms="${t5 - t4}"/>`)
    console.log(`  <total ms="${t5 - t0}"/>`)
    console.log('</pipeline>')
    if (flags.out) {
      const dir = path.resolve(String(flags.out))
      fs.mkdirSync(dir, { recursive: true })
      const stats = { schema: SCHEMA, files: files.length, symbols: symbols.length, edges: edges.length, typeEdges: typeEdges.length, ambiguous, ambTypes, localOnly }
      const w = (name, obj) => {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(obj) + '\n', 'utf8')
        console.log(`  ✓ ${posix(path.relative(REPO, path.join(dir, name)))}`)
      }
      w('skeletons.json', { ...stats, phase: 1, skeletons: symbols.map(({ body, refs, qrefs, trefs, ...s }) => s) })
      w('call_graph.json', { ...stats, phase: 2, edges, typeEdges, ambRefs })
      w('imports.json', { ...stats, phase: 2, imports: Object.fromEntries([...importsOf].sort((a, b) => a[0].localeCompare(b[0]))) })
      w('scored_symbols.json', {
        ...stats, phase: 3,
        config: { whitelist: cfg.whitelist, genericDamp: cfg.genericDamp, testDamp: cfg.testDamp, vendorDamp: cfg.vendorDamp },
        scored: scored.map((r) => ({
          i: r.i, n: r.s.n, q: r.s.q, p: r.s.p, l: r.s.l, score: +r.score.toFixed(4),
          norm: +r.norm.toFixed(3), factors: { kind: r.k, path: r.pw, name: r.nw, span: r.sw, breadth: r.bw }, tags: r.tags,
        })),
      })
      w('hub_ranking.json', {
        ...stats, phase: 4,
        hubs: collapsed.slice(0, 50).map((r, k) => ({ rank: k + 1, n: r.s.n, q: r.s.q, p: r.s.p, l: r.s.l, score: +r.score.toFixed(4), amb: r.ambCount })),
        groups: groups.slice(0, 50).map((g) => ({ name: g.name, defs: g.idxs.length, refs: g.refs })),
      })
    }
    break
  }
  default:
    console.log('用法：node repoctx.mjs <index|pipeline|for|symbol|callers|callees|impact|affected|impls|typerefs|imports|context|tree|files|hubs|amb|policy|note|notes|export|check> [args]')
    console.log('示例：for "auth token refresh" | callers loadConfig | impact loadConfig | context loadConfig')
    console.log('     files [--by size|syms|cx|dupes] [--dir PREFIX]  # 文件级度量：最大/最密/最复杂/同名文件')
    console.log('     typerefs NAME | imports NAME               # 类型引用双向 / 谁导入了它')
    console.log('     hubs --explain | amb | amb run       # 枢纽打分（含因子）/ 歧义组 / 展开某一组')
    console.log('     pipeline [--out DIR]  # 五阶段流水线（每阶段耗时 + counts；可导出五个派生视图）')
    console.log('     affected --diff [rev] | affected --files a.rs,b.ts   # PR 复核：改动文件 → 波及符号')
    console.log('     impls OfficeTool | impls Default                     # 接口/实现双向查询（外部 trait 也查得到实现）')
    console.log('     policy [--policy FILE] [--all]            # 模块边界检查（读 .repoctx/policy.yaml；只拦新增）')
    console.log('     policy --baseline-update                  # 人工把当前违规入账（reviewed 才能刷）')
    console.log('     note --sym runRules --text "…" --kind pitfall --rel 其他符号 --alias 别名 | notes [--drift|--kind K]')
    process.exit(2)
}
