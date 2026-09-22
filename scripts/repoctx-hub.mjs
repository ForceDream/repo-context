

















import fs from 'node:fs'
import path from 'node:path'


export const GENERIC_NAMES = new Set([

  'len', 'push', 'pop', 'is_empty', 'empty', 'kind', 'new', 'from_json', 'to_json', 'json', 'parse',
  'serialize', 'deserialize', 'get', 'set', 'add', 'remove', 'update', 'create', 'delete',

  'as_str', 'to_string', 'clone', 'default', 'unwrap', 'collect', 'iter', 'iter_mut', 'map', 'filter',
  'find', 'insert', 'contains', 'from', 'into', 'main', 'init', 'next', 'some', 'ok', 'err', 'format',
  'print', 'log', 'run', 'index', 'count', 'items', 'keys', 'values', 'entry', 'first', 'last',
  'text', 'path', 'file', 'read', 'write', 'open', 'close', 'data', 'value', 'name', 'type', 'size',
  'string', 'number', 'boolean', 'object', 'array', 'status', 'message', 'args',
])


export const VENDOR_PATH = /(^|\/)(node_modules|vendor|third_party|thirdparty|external|extern|\.cargo|registry|site-packages|dist-packages|Godeps)(\/|$)/


export const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|samples?|bench|benchmarks?)(\/|$)|\.(test|spec|_test|_spec)\.[a-z]+$/i


export const KIND_WEIGHT = {
  fn: 1, method: 1, class: 1, iface: 1, struct: 1, enum: 1, trait: 1,
  impl: 0.9, type: 0.9, macro: 0.85, const: 0.8, mod: 0.7, var: 0.4,



  field: 0, prop: 0, variant: 0,
  other: 0.5, sec: 0, doc: 0,
}

export const DEFAULT_CONFIG = { whitelist: [], genericDamp: 0.15, testDamp: 0.5, vendorDamp: 0.2 }








export function loadHubConfig(outDir) {
  const file = path.join(outDir, 'config.json')
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG, source: null }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const hub = raw.hub || {}
    return {
      whitelist: Array.isArray(hub.whitelist) ? hub.whitelist : [],
      genericDamp: typeof hub.genericDamp === 'number' ? hub.genericDamp : DEFAULT_CONFIG.genericDamp,
      testDamp: typeof hub.testDamp === 'number' ? hub.testDamp : DEFAULT_CONFIG.testDamp,
      vendorDamp: typeof hub.vendorDamp === 'number' ? hub.vendorDamp : DEFAULT_CONFIG.vendorDamp,
      source: file,
    }
  } catch (e) {

    return { ...DEFAULT_CONFIG, source: file, error: e.message }
  }
}

export const isVendorPath = (p) => VENDOR_PATH.test(p)
export const isTestPath = (p) => TEST_PATH.test(p)








export function stripNoise(text, lang) {
  let t = text
  if (lang === 'py') t = t.replace(/#[^\n]*/g, ' ')
  else t = t.replace(/\/\*[\s\S]*?\*\//g, ' ')

  t = t.replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ')



  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    t = t.replace(/((?:^|[=(,:;[!&|?{]|\breturn)\s*)\/(?!\s)(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g, '$1/RE/')
  }
  t = t.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')


  t = lang === 'rust'
    ? t.replace(/'(?:\\.|[^'\\\n])'/g, "''")
    : t.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  t = t.replace(/`(?:[^`\\]|\\.)*`/g, '``')
  return t
}







export function createHubModel({ symbols, edges, config }) {
  const sameName = new Map()
  for (const s of symbols) sameName.set(s.n, (sameName.get(s.n) || 0) + 1)

  const incoming = new Map()
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    incoming.get(e.to).push(e.from)
  }

  const whitelist = new Set(config.whitelist || [])

  
  function score(i) {
    const s = symbols[i]
    if (!s) return null
    if (s.t === 'sec' || s.t === 'doc') return null
    if (s.local) return null
    if (isVendorPath(s.p)) return null

    const inc = incoming.get(i) || []
    if (!inc.length) return null


    let win = 0
    const callerFiles = new Set()
    for (const src of inc) {
      const sp = symbols[src]?.p || ''
      callerFiles.add(sp)
      let w = 1
      if (sp === s.p) w *= 0.7
      if (isTestPath(sp)) w *= config.testDamp
      win += w
    }

    const amb = sameName.get(s.n) || 1
    const norm = win / amb
    const k = KIND_WEIGHT[s.t] ?? 0.5
    const pw = isTestPath(s.p) ? config.testDamp : 1
    const nw = whitelist.has(s.n) ? 1 : (GENERIC_NAMES.has(s.n) ? config.genericDamp : 1)
    const span = (s.el && s.l) ? (s.el - s.l + 1) : 1
    const sw = span < 3 ? 0.7 : 1
    const bw = callerFiles.size >= 3 ? 1.15 : callerFiles.size === 2 ? 1 : 0.85

    return {
      score: norm * k * pw * nw * sw * bw,
      win, norm, amb, k, pw, nw, sw, bw, span,
      callers: inc.length,
      callerFiles: callerFiles.size,
      tags: [
        GENERIC_NAMES.has(s.n) && !whitelist.has(s.n) ? '泛用名降权' : null,
        whitelist.has(s.n) ? '白名单' : null,
        isTestPath(s.p) ? '测试路径' : null,
        s.local ? '局部' : null,
      ].filter(Boolean),
    }
  }

  
  function ranking(limit = Infinity) {
    const rows = []
    for (let i = 0; i < symbols.length; i++) {
      const f = score(i)
      if (f) rows.push({ i, s: symbols[i], ...f })
    }
    rows.sort((a, b) => b.score - a.score || a.s.n.localeCompare(b.s.n) || a.i - b.i)
    return rows.slice(0, limit)
  }

  
  function ambGroups(ambRefs = {}) {
    const byName = new Map()
    symbols.forEach((s, i) => {
      if (!byName.has(s.n)) byName.set(s.n, [])
      byName.get(s.n).push(i)
    })
    const out = []
    for (const [name, idxs] of byName) {
      if (idxs.length < 2) continue


      const refs = Object.hasOwn(ambRefs, name) ? ambRefs[name] : 0
      out.push({ name, idxs, refs, vendorOnly: idxs.every((i) => isVendorPath(symbols[i].p)) })
    }
    out.sort((a, b) => b.refs - a.refs || b.idxs.length - a.idxs.length || a.name.localeCompare(b.name))
    return out
  }

  



  function collapse(rows) {
    const best = new Map()
    for (const r of rows) {
      const cur = best.get(r.s.n)
      if (!cur || r.score > cur.score) best.set(r.s.n, r)
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.s.n.localeCompare(b.s.n) || a.i - b.i)
      .map((r) => ({ ...r, ambCount: sameName.get(r.s.n) || 1 }))
  }

  return { score, ranking, ambGroups, collapse, sameNameCount: (n) => sameName.get(n) || 0 }
}









export function hubNormTable(rows, n) {
  const norm = new Float64Array(n)
  let max = 0
  for (const r of rows) if (r.score > max) max = r.score
  if (max > 0) {
    const denom = Math.log1p(max)
    for (const r of rows) norm[r.i] = Math.log1p(Math.max(0, r.score)) / denom
  }
  return { norm, max }
}
