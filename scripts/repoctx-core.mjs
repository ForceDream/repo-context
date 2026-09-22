












import fs from 'node:fs'
import path from 'node:path'
import { createHubModel, hubNormTable, loadHubConfig } from './repoctx-hub.mjs'


export const SCHEMA = 'repoctx/2'



export const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')


export function createQueryLayer({ repo, outDir, includeDocs = false }) {
  const REPO = repo
  const OUT_DIR = outDir
  const MAP_FILE = path.join(outDir, 'map.json')
  const NOTES_FILE = path.join(outDir, 'notes.jsonl')
  const INCLUDE_DOCS = includeDocs

  function pagerank(n, edges, iters = 20, damping = 0.85) {
    const out = Array.from({ length: n }, () => [])
    for (const e of edges) out[e.from].push(e.to)
    let rank = new Array(n).fill(1 / n)
    for (let it = 0; it < iters; it++) {
      const next = new Array(n).fill((1 - damping) / n)
      let dangling = 0
      for (let i = 0; i < n; i++) {
        if (out[i].length === 0) { dangling += rank[i]; continue }
        const share = (damping * rank[i]) / out[i].length
        for (const t of out[i]) next[t] += share
      }
      const d = (damping * dangling) / n
      for (let i = 0; i < n; i++) next[i] += d
      rank = next
    }
    return rank
  }



  function tokenize(text) {
    return (text.toLowerCase().match(/[\p{L}\p{N}_$]{2,}/gu) || [])
  }

  function loadMap() {
    if (!fs.existsSync(MAP_FILE)) {
      console.error(`✗ 还没有索引：先跑  node repoctx.mjs index --repo "${REPO}"`)
      process.exit(2)
    }
    const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))

    if (m.schema !== SCHEMA) {
      console.error(`✗ 产物版本不符（磁盘 ${m.schema || '无'} ≠ 当前 ${SCHEMA}）：请重跑  node repoctx.mjs index --repo "${REPO}"`)
      process.exit(2)
    }
    return m
  }





  function readNotes() {
    if (!fs.existsSync(NOTES_FILE)) return []
    return fs.readFileSync(NOTES_FILE, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  }

  const HUB_WEIGHT = 1.5
  function lensFor(map, query, top) {
    const terms = tokenize(query)
    if (!terms.length) return map.symbols.slice(0, top).map((s, i) => ({ s, score: 0, i }))
    const { norm: hubNorm } = hubModelOf(map)
    const scored = map.symbols.map((s, i) => {
      const name = s.n.toLowerCase()
      const p = s.p.toLowerCase()
      const doc = (s.doc || '').toLowerCase()
      let score = 0
      for (const t of terms) {
        if (name === t) score += 12
        else if (name.includes(t)) score += 8
        if (p.includes(t)) score += 4
        if (doc.includes(t)) score += 3
        if ((s.sig || '').toLowerCase().includes(t)) score += 2
      }
      if (score > 0) score += HUB_WEIGHT * (hubNorm[i] || 0) + 0.02 * (map.churn[s.p] || 0)
      return { s, score, i }
    })
    return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.s.p.localeCompare(b.s.p) || a.s.l - b.s.l).slice(0, top)
  }

  let _rank = null
  
  function callEdges(map) {
    return INCLUDE_DOCS ? map.edges : map.edges.filter((e) => e.prov !== 'doc')
  }
  




  const mapKey = (map) => `${map.symbols.length}|${map.edges.length}|${(map.typeEdges || []).length}|${Object.keys(map.ambRefs || {}).length}|docs=${INCLUDE_DOCS ? 1 : 0}`

  function pagerankOf(map) {
    const k = mapKey(map)
    if (!_rank || _rank.k !== k) {
      _rank = { k, r: pagerank(map.symbols.length, callEdges(map)) }
    }
    return _rank.r
  }

  let _adjs = null
  




  function adjacencyOf(map) {
    const k = mapKey(map)
    if (_adjs && _adjs.k === k) return _adjs
    const edges = callEdges(map)
    const inDeg = new Int32Array(map.symbols.length)
    const out = new Map()
    for (const e of edges) {
      inDeg[e.to]++
      let list = out.get(e.from)
      if (!list) { list = []; out.set(e.from, list) }
      list.push(e.to)
    }
    _adjs = { k, inDeg, out }
    return _adjs
  }
  function inDegree(map, idx) { return adjacencyOf(map).inDeg[idx] }
  function calleesOf(map, idx) { return adjacencyOf(map).out.get(idx) || [] }

  let _hub = null
  





  function hubModelOf(map) {
    const cfg = loadHubConfig(OUT_DIR)

    const key = `${mapKey(map)}|${cfg.source || 'default'}|${(cfg.whitelist || []).join(',')}`
    if (!_hub || _hub.key !== key) {
      const model = createHubModel({ symbols: map.symbols, edges: callEdges(map), config: cfg })


      const { norm, max } = hubNormTable(model.ranking(), map.symbols.length)
      _hub = { key, model, cfg, norm, max }
    }
    return _hub
  }
  
  function ambGroupsOf(map) { return hubModelOf(map).model.ambGroups(map.ambRefs || {}) }

  








  const isDocSymbol = (s) => !!s && (s.t === 'sec' || s.t === 'doc')
  
  function docCountOf(map, g) { return g.idxs.reduce((n, i) => n + (isDocSymbol(map.symbols[i]) ? 1 : 0), 0) }
  
  const isDocOnlyGroup = (map, g) => g.idxs.length > 0 && docCountOf(map, g) === g.idxs.length
  



  function codeAmbGroups(map) {
    const all = ambGroupsOf(map)
    const code = all.filter((g) => !isDocOnlyGroup(map, g))
    return { all, code, hidden: all.length - code.length }
  }
  
  function collapseRows(map, rows) {
    const best = new Map()
    for (const r of rows) {
      const cur = best.get(r.s.n)
      if (!cur || r.score > cur.score) best.set(r.s.n, r)
    }
    return [...best.values()].map((r) => ({ ...r, ambCount: hubModelOf(map).model.sameNameCount(r.s.n) }))
  }


  
  function impactDetail(map, idx, depth, { types = false } = {}) {
    const incoming = new Map()
    const add = (e, fam) => {
      if (!incoming.has(e.to)) incoming.set(e.to, [])
      incoming.get(e.to).push({ from: e.from, fam })
    }
    for (const e of callEdges(map)) add(e, 'call')
    if (types) for (const e of map.typeEdges || []) add(e, 'type')
    const via = new Map()
    let frontier = [idx]
    for (let d = 0; d < depth; d++) {
      const next = new Set()
      const pending = new Map()
      for (const f of frontier) {
        for (const { from, fam } of (incoming.get(f) || [])) {
          if (from === idx || via.has(from) || pending.has(from)) continue
          pending.set(from, fam)
          next.add(from)
        }
      }
      if (!next.size) break
      for (const [n, fam] of pending) via.set(n, fam)
      frontier = [...next]
    }
    const rank = pagerankOf(map)
    const list = [...via.keys()].sort((a, b) => rank[b] - rank[a])
    const viaType = new Set([...via].filter(([, f]) => f === 'type').map(([n]) => n))
    return { list, viaType }
  }
  
  const impact = (map, idx, depth, opts) => impactDetail(map, idx, depth, opts).list

  function resolveSymbol(map, name) {
    if (name === undefined || name === null || name === '') {


      console.error('用法：repoctx <symbol|callers|callees|impact|context> <NAME> [flags]')
      process.exit(2)
    }
    const hits = map.symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.n === name)
    if (!hits.length) {
      const fuzzy = map.symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.n.toLowerCase().includes(name.toLowerCase()))
      if (!fuzzy.length) { console.error(`✗ 找不到符号：${name}`); process.exit(3) }



      console.log(`<!-- 精确名未命中：「${name}」按**子串模糊匹配**返回前 ${Math.min(fuzzy.length, 10)} 条；以下输出（含闭包）基于其中第一条，请核对 -->`)
      return fuzzy.slice(0, 10)
    }
    return hits
  }

  function symLine(map, i, extra = '') {
    const s = map.symbols[i]
    const rank = pagerankOf(map)[i] || 0


    const q = s.q ? ` q="${esc(s.q)}"` : ''

    const cxOwn = s.cxOwn != null && s.cxOwn !== s.cx ? ` cxOwn="${s.cxOwn}"` : ''
    return `<s t="${s.t}" n="${esc(s.n)}"${q} p="${esc(s.p)}" l="${s.l}" cx="${s.cx}"${cxOwn} in="${inDegree(map, i)}" rank="${rank.toFixed(4)}"${extra}>${esc(s.sig)}</s>`
  }

  











  function confNote(map, i, n) {
    const model = hubModelOf(map).model
    const ambN = model.sameNameCount(map.symbols[i].n)
    if (ambN > 1) {
      return n === 0
        ? ` conf="none" reason="${esc(`歧义名（${ambN} 处同名定义）：默认不连边，仅同文件唯一候选例外（prov=scope-unique），此处未命中所以 n=0 **不代表无人使用**；展开候选用 amb ${map.symbols[i].n}`)}"`
        : ` conf="low" reason="${esc(`歧义名（${ambN} 处同名定义）：只连上了能唯一确定的那部分引用（含 prov=scope-unique），结果不全`)}"`
    }
    const f = model.score(i)
    if (f && f.tags.includes('泛用名降权')) {
      return ' conf="low" reason="泛用名：名字级匹配会混入同名 stdlib 调用（实测抽查 is_empty 的 5 个调用方仅 1 个指向本定义）——要精确引用需类型级工具"'
    }
    return ''
  }

  






  function estTokens(text) {
    let ascii = 0, wide = 0
    for (let i = 0; i < text.length; i++) (text.charCodeAt(i) > 0x2e7f ? wide++ : ascii++)
    return Math.ceil(ascii / 4 + wide)
  }

  return {
    loadMap, readNotes, callEdges, pagerankOf, inDegree, calleesOf, hubModelOf, ambGroupsOf, collapseRows,
    isDocSymbol, docCountOf, isDocOnlyGroup, codeAmbGroups,
    symLine, confNote, resolveSymbol, impactDetail, impact, lensFor, tokenize, estTokens,
  }
}
