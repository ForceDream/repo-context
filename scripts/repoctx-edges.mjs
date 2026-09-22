














import path from 'node:path'
import { isVendorPath, stripNoise } from './repoctx-hub.mjs'
import { LANG_BY_EXT } from './repoctx-files.mjs'







export const langFamily = (p) => (p.endsWith('.rs') ? 'rs' : (/\.(ts|tsx|js|jsx|mjs)$/.test(p) ? 'ts' : 'other'))










export const MEMBER_KINDS = new Set(['field', 'prop', 'variant'])








export function aliasScan(text, lang) {
  const out = new Map()
  if (lang === 'rust') {
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;{]+)(\{[^}]*\})?[ \t]*;/gm)) {
      const head = m[1]
      const items = m[2] ? m[2].slice(1, -1).split(',') : [head.split('::').pop()]
      for (const it of items) {
        const p = it.trim().split(/\s+as\s+/)
        if (p.length === 2 && /^[A-Za-z_]\w*$/.test(p[1].trim())) out.set(p[1].trim(), p[0].trim().split('::').pop())
      }
    }
  } else if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    for (const m of text.matchAll(/^[ \t]*import[ \t]*\{([^}]*)\}[ \t]*from/gm)) {
      for (const it of m[1].split(',')) {
        const p = it.trim().split(/\s+as\s+/)
        if (p.length === 2 && /^[A-Za-z_$]\w*$/.test(p[1].trim())) out.set(p[1].trim(), p[0].trim())
      }
    }
  }
  return out
}












export function reexportScan(text, lang) {
  const out = []
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    for (const m of text.matchAll(/^[ \t]*export[ \t]+(?:type[ \t]+)?\{([^}]*)\}[ \t]*from/gm)) {
      for (const it of m[1].split(',')) {
        const p = it.trim().split(/\s+as\s+/)
        if (p.length === 2 && /^[A-Za-z_$][\w$]*$/.test(p[0].trim()) && /^[A-Za-z_$][\w$]*$/.test(p[1].trim())) {
          out.push({ name: p[0].trim(), as: p[1].trim() })
        } else if (p.length === 1 && /^[A-Za-z_$][\w$]*$/.test(p[0].trim())) {
          out.push({ name: p[0].trim(), as: p[0].trim() })
        }
      }
    }
  } else if (lang === 'rust') {
    for (const m of text.matchAll(/^[ \t]*pub(?:\([^)]*\))?[ \t]+use[ \t]+([^;{]+)(\{[^}]*\})?[ \t]*;/gm)) {
      const head = m[1]
      const items = m[2] ? m[2].slice(1, -1).split(',') : [head]
      for (const it of items) {
        const p = it.trim().split(/\s+as\s+/)
        if (p.length === 2 && /^[A-Za-z_]\w*$/.test(p[0].trim().split('::').pop()) && /^[A-Za-z_]\w*$/.test(p[1].trim())) {
          out.push({ name: p[0].trim().split('::').pop(), as: p[1].trim() })
        } else if (p.length === 1 && /^[A-Za-z_]\w*$/.test(p[0].trim().split('::').pop())) {
          const nm = p[0].trim().split('::').pop()
          out.push({ name: nm, as: nm })
        }
      }
    }
  }
  return out
}

export function buildEdges(symbols, aliases) {

  const byName = new Map()
  symbols.forEach((s, i) => {
    if (!byName.has(s.n)) byName.set(s.n, [])
    byName.get(s.n).push(i)
  })
  const edges = []
  let ambiguous = 0





  let localOnly = 0
  const allLocalVarConst = (arr) => arr.every((j) => (symbols[j].t === 'var' || symbols[j].t === 'const') && symbols[j].local === true)




  const ambRefs = Object.create(null)
  const TOKEN_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu
  symbols.forEach((s, i) => {
    const seen = new Set()



    const langHint = LANG_BY_EXT[path.extname(s.p).toLowerCase()] || ''
    const tokens = s.refs || (stripNoise(s.body || '', langHint).match(TOKEN_RE) || [])







    const qResolved = new Set()
    for (const qr of s.qrefs || []) {
      if (qr.name === s.n || qr.name.length < 3 || seen.has(qr.name)) continue
      seen.add(qr.name)
      let p = qr.path
      while (/^(crate|self|super)::/.test(p)) p = p.replace(/^(crate|self|super)::/, '')
      const full = `${p}::${qr.name}`
      const defs0 = byName.get(qr.name)
      if (!defs0 || !defs0.length) continue
      const defs = defs0.filter((j) => !MEMBER_KINDS.has(symbols[j].t))
      if (!defs.length) continue
      const usable = defs.filter((j) => {
        if (j === i || isVendorPath(symbols[j].p)) return false
        const q = symbols[j].q

        if (q === full || (!!q && (q.endsWith(`::${full}`) || full.endsWith(`::${q}`)))) return true


        if (q === undefined && symbols[j].p.endsWith('.rs')) {
          const base = path.basename(symbols[j].p)
          const stem = base === 'mod.rs' ? path.basename(path.dirname(symbols[j].p)) : base.replace(/\.[^.]+$/, '')
          return stem === p.split('::').pop()
        }
        return false
      })
      if (!usable.length) continue
      if (usable.length > 1) {
        if (allLocalVarConst(usable)) { localOnly++; continue }
        ambiguous++
        ambRefs[qr.name] = (ambRefs[qr.name] || 0) + 1
        continue
      }
      edges.push({ from: i, to: usable[0], prov: 'qname' })
      qResolved.add(qr.name)
    }
    for (const tk of tokens) {
      if (tk === s.n || tk.length < 3 || seen.has(tk)) continue
      seen.add(tk)


      let viaAlias = false
      let defs = byName.get(tk)
      if ((!defs || !defs.length) && aliases) {
        const al = aliases.get(s.p)
        const orig = al && al.get(tk)
        if (orig) { defs = byName.get(orig); viaAlias = !!(defs && defs.length) }
      }
      if (!defs || !defs.length) continue

      defs = defs.filter((j) => !MEMBER_KINDS.has(symbols[j].t))
      if (!defs.length) continue





      const f1 = langFamily(s.p)
      const usable = defs.filter((j) => {
        if (j === i || isVendorPath(symbols[j].p)) return false




        if (symbols[j].t === 'impl') return false
        const f2 = langFamily(symbols[j].p)
        return f1 === 'other' || f2 === 'other' || f1 === f2
      })
      if (!usable.length) continue
      if (usable.length > 1) {








        const sameFile = usable.filter((j) => symbols[j].p === s.p)
        const realCollision = usable.every((j) => symbols[j].t === 'fn' || symbols[j].t === 'method')
          && new Set(usable.map((j) => symbols[j].p)).size > 1





        if (s.t !== 'sec' && realCollision && usable.length <= 3 && sameFile.length === 1) {
          edges.push({ from: i, to: sameFile[0], prov: 'scope-unique' })
          continue
        }



        if (s.t !== 'sec' && sameFile.length === 1) {
          const c = symbols[sameFile[0]]
          if (!c.q && c.t !== 'var' && c.t !== 'const') {
            edges.push({ from: i, to: sameFile[0], prov: 'lexical' })
            continue
          }
        }





        const vis = usable.filter((j) => {
          const c = symbols[j]
          if (c.p === s.p) return true
          if (c.exp === undefined) return true
          if (f1 === 'ts') return c.exp === true
          if (c.exp === true) return true
          const cd = c.p.slice(0, c.p.lastIndexOf('/'))
          return s.p.startsWith(cd + '/')
        })
        if (s.t !== 'sec' && vis.length === 1 && symbols[vis[0]].p !== s.p && symbols[vis[0]].local !== true) {
          edges.push({ from: i, to: vis[0], prov: 'visibility' })
          continue
        }
        if (allLocalVarConst(usable)) { localOnly++; continue }
        ambiguous++
        ambRefs[tk] = (ambRefs[tk] || 0) + 1
        continue
      }
      const j = usable[0]


      const prov = viaAlias ? 'alias' : (s.t === 'sec' ? 'doc' : (symbols[j].p === s.p ? 'same-file' : 'name'))
      edges.push({ from: i, to: j, prov })
    }
  })




  












  const TYPE_KINDS = new Set(['struct', 'enum', 'trait', 'type', 'iface', 'class'])
  const typeEdges = []
  let ambTypes = 0
  symbols.forEach((s, i) => {
    for (const tn of s.trefs || []) {
      const defs = byName.get(tn)
      if (!defs || !defs.length) continue
      const usable = defs.filter((j) => {
        if (j === i) return false
        const c = symbols[j]
        if (!TYPE_KINDS.has(c.t)) return false
        if (isVendorPath(c.p)) return false
        const fam = langFamily(c.p)
        return fam === langFamily(s.p) || fam === 'other'
      })
      if (!usable.length) continue
      if (usable.length === 1) { typeEdges.push({ from: i, to: usable[0], prov: 'type' }); continue }
      const sameFile = usable.filter((j) => symbols[j].p === s.p)
      if (sameFile.length === 1) { typeEdges.push({ from: i, to: sameFile[0], prov: 'type' }); continue }
      ambTypes++
    }
  })
  return { edges, typeEdges, ambiguous, ambRefs, ambTypes, localOnly }
}

let _disp = null











export function dispatchOf(map) {
  if (_disp && _disp.key === map.symbols.length) return _disp.t
  const syms = map.symbols
  const isM = (s) => s.t === 'fn' || s.t === 'method'
  const inSpan = (host, s) => s.p === host.p && s.l > host.l && s.el <= host.el

  const traitMethods = new Map()
  syms.forEach((s, i) => {
    if (s.t !== 'trait') return
    let m = traitMethods.get(s.n)
    if (!m) { m = new Map(); traitMethods.set(s.n, m) }
    syms.forEach((x, j) => { if (isM(x) && inSpan(s, x) && !m.has(x.n)) m.set(x.n, j) })
  })
  const t = new Map()
  syms.forEach((s, i) => {
    if (s.t !== 'impl' || !s.tr) return
    const m = traitMethods.get(s.tr)
    if (!m) return
    syms.forEach((x, j) => {
      if (!isM(x) || !inSpan(s, x)) return
      const from = m.get(x.n)
      if (from === undefined) return
      if (!t.has(from)) t.set(from, new Set())
      t.get(from).add(j)
    })
  })
  _disp = { key: map.symbols.length, t }
  return t
}
