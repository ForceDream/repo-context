

























import { createHash } from 'node:crypto'
import { isVendorPath } from './repoctx-hub.mjs'
import { MEMBER_KINDS } from './repoctx-edges.mjs'


export function fingerprint(rule, file, detail) {
  return createHash('sha256').update(`${rule}\0${file}\0${detail}`).digest('hex').slice(0, 16)
}

const normPath = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')

function parseVal(v) {
  const t = String(v).trim()
  if (/^\[.*\]$/.test(t)) {
    return t.slice(1, -1).split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  return t.replace(/^['"]|['"]$/g, '')
}












export function parsePolicy(text) {
  const out = { version: 1, modules: [], global: {} }
  let section = null
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(^|\s)#.*$/, '').replace(/\t/g, '  ')
    if (!line.trim()) continue
    if (/^[A-Za-z][\w-]*:/.test(line)) {
      const idx = line.indexOf(':')
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key === 'modules') { section = 'modules'; cur = null }
      else if (key === 'global') { section = 'global'; cur = null }
      else if (key === 'version') { out.version = Number(val) || 1; section = null }
      else { section = null; cur = null }
      continue
    }
    if (section === 'modules') {
      const dash = line.match(/^\s*-\s+(.*)$/)
      if (dash) { cur = {}; out.modules.push(cur); line = dash[1] }
      if (!cur) continue
      const kv = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*)$/)
      if (kv) cur[kv[1]] = parseVal(kv[2])
    } else if (section === 'global') {
      const kv = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*)$/)
      if (kv) out.global[kv[1]] = parseVal(kv[2])
    }
  }

  for (const m of out.modules) {
    m.id = String(m.id ?? '').trim()
    m.roots = (Array.isArray(m.roots) ? m.roots : m.roots ? [m.roots] : []).map(normPath).filter(Boolean)
    m.managed = m.managed === true
    m.requires = (Array.isArray(m.requires) ? m.requires : m.requires ? [m.requires] : []).map((x) => String(x).trim()).filter(Boolean)
    m.publicEntrypoints = (Array.isArray(m.publicEntrypoints) ? m.publicEntrypoints : m.publicEntrypoints ? [m.publicEntrypoints] : []).map(normPath).filter(Boolean)
    m.owner = m.owner ? String(m.owner).trim() : undefined
  }
  out.global.forbidCycles = out.global.forbidCycles !== false
  out.global.forbidDeepImports = out.global.forbidDeepImports !== false
  return out
}

export function validatePolicy(policy) {
  const errs = []
  if (!policy.modules.length) errs.push('policy 未声明任何模块（modules: 为空）')
  const ids = new Set()
  for (const m of policy.modules) {
    if (!m.id) errs.push('存在缺 id 的模块项')
    else if (ids.has(m.id)) errs.push(`模块 id 重复：${m.id}`)
    ids.add(m.id)
    if (!m.roots.length) errs.push(`模块 ${m.id || '?'} 未声明 roots`)
  }
  return errs
}

const POLICY_TEMPLATE = `version: 1

# 每个模块声明：归不归管、依赖谁、对外只开哪个入口、谁负责。
# managed: false 的模块只登记拓扑、不产生违规（旧代码渐进纳管）。
modules:
  - id: core
    roots: [src/core]
    managed: true
    requires: [shared]
    publicEntrypoints: [src/core/contract.ts]
    owner: your-team
  - id: legacy
    roots: [src/legacy]
    managed: false

global:
  forbidCycles: true
  forbidDeepImports: true
`


function modOfPathFn(policy) {
  const rootList = policy.modules
    .flatMap((m) => m.roots.map((r) => ({ r, m })))
    .sort((a, b) => b.r.length - a.r.length)
  return (p) => {
    for (const { r, m } of rootList) if (p === r || p.startsWith(r + '/')) return m
    return null
  }
}








export function runPolicyCheck(map, policy, baseline = { version: 1, violations: [] }) {
  const byId = new Map(policy.modules.map((m) => [m.id, m]))
  const modOfPath = modOfPathFn(policy)
  const violations = []
  const V = (rule, file, detail, module) =>
    violations.push({ rule, file, detail, module: module || null, fp: fingerprint(rule, file, detail) })


  for (const m of policy.modules) {
    for (const dep of m.requires) {
      if (!byId.has(dep)) V('unknown-module', m.roots[0] || m.id, `模块 ${m.id} 的 requires 声明了未注册模块「${dep}」`, m.id)
    }
    for (const ep of m.publicEntrypoints) {
      if (!map.files.some((f) => f.p === ep)) {
        V('missing-entrypoint', ep, `模块 ${m.id} 声明的公共入口在索引中不存在（未跟踪 / 被 .gitignore 忽略 / 路径写错？）`, m.id)
      }
    }
  }


  const syms = map.symbols
  const depCount = new Map()
  const addDep = (fromP, toSym) => {
    const A = modOfPath(fromP)
    const B = modOfPath(toSym.p)
    if (!A || !B || A.id === B.id || isVendorPath(toSym.p)) return
    const k = `${A.id}>${B.id}`
    const rec = depCount.get(k) || { n: 0, sample: fromP, deep: 0, deepSample: null }
    rec.n++

    if (B.managed && B.publicEntrypoints.length && !B.publicEntrypoints.includes(toSym.p)) {
      rec.deep++
      rec.deepSample = rec.deepSample || toSym.p
    }
    depCount.set(k, rec)
  }
  let unmappedEdges = 0
  for (const e of map.edges) {
    if (e.prov === 'doc') continue
    const fromP = syms[e.from].p
    if (!modOfPath(fromP) || !modOfPath(syms[e.to].p)) { unmappedEdges++; continue }
    addDep(fromP, syms[e.to])
  }

  const byName = new Map()
  syms.forEach((s, i) => {
    if (s.t === 'impl' || MEMBER_KINDS.has(s.t)) return
    if (!byName.has(s.n)) byName.set(s.n, [])
    byName.get(s.n).push(i)
  })
  for (const [file, names] of Object.entries(map.imports || {})) {
    for (const name of names) {
      const defs = byName.get(name)
      if (!defs || defs.length !== 1) continue
      const toSym = syms[defs[0]]
      if (modOfPath(file) && modOfPath(toSym.p)) addDep(file, toSym)
    }
  }


  for (const [k, rec] of depCount) {
    const [a, b] = k.split('>')
    const A = byId.get(a)
    const B = byId.get(b)
    const enforced = A.managed || B.managed
    if (!enforced) continue
    if (A && !A.requires.includes(b)) {
      V('module-dependency', rec.sample, `${a} → ${b}（${rec.n} 条边）但 ${a}.requires 未声明 ${b}`, a)
    }
    if (B && B.managed && rec.deep > 0 && policy.global.forbidDeepImports) {
      V('deep-import', rec.sample, `${a} → ${b}：${rec.deep} 处引用落在 ${b} 的入口文件之外（如 ${rec.deepSample}）；入口 = ${B.publicEntrypoints.join(', ')}`, b)
    }
  }


  if (policy.global.forbidCycles) {
    const adj = new Map()
    for (const k of depCount.keys()) {
      const [a, b] = k.split('>')
      if (!byId.get(a)?.managed && !byId.get(b)?.managed) continue
      if (!adj.has(a)) adj.set(a, new Set())
      adj.get(a).add(b)
    }
    const state = new Map()
    const stack = []
    const seen = new Set()
    const visit = (node) => {
      state.set(node, 1)
      stack.push(node)
      for (const next of adj.get(node) || []) {
        if (state.get(next) === 1) {
          const idx = stack.indexOf(next)
          const cycle = stack.slice(idx).concat(next)
          const key = [...new Set(cycle)].sort().join('->')
          if (!seen.has(key)) {
            seen.add(key)
            const host = cycle.find((id) => byId.get(id)?.managed) || cycle[0]
            V('cycle', byId.get(host)?.roots[0] || host, `模块依赖环：${cycle.map((x) => (x === host ? `${x} (managed)` : x)).join(' -> ')}`, host)
          }
        } else if (!state.get(next)) visit(next)
      }
      stack.pop()
      state.set(node, 2)
    }
    for (const node of adj.keys()) if (!state.get(node)) visit(node)
  }


  const accounted = new Set((baseline.violations || []).map((v) => v.fp))
  const newViolations = []
  let baselineCount = 0
  for (const v of violations) {
    if (accounted.has(v.fp)) baselineCount++
    else newViolations.push(v)
  }
  return { violations, newViolations, baselineCount, stats: { unmappedEdges, depPairs: depCount.size } }
}

export { POLICY_TEMPLATE }
