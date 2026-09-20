/**
 * repoctx-core —— **读取侧（查询/渲染）**：从 repoctx.mjs 切出（2026-09-16 审核 P2-1 第二轮）
 *
 * 与写入侧的边界：**写入侧**（buildIndex/buildEdges/buildMap/churn）只认源码 → 产出 map.json；
 * **读取侧**（本模块）只认 map.json + notes.jsonl → 产出人/Agent 能读的答案。两者唯一的交汇是产物契约（SCHEMA）。
 *
 * 为什么用工厂而不是平铺导出：这些 helper 依赖 CLI 状态（repo 用于错误提示、outDir 决定产物位置、
 * includeDocs 决定是否把 doc 边算进调用图）。`createQueryLayer({...})` 把状态注入成闭包，
 * 主文件解构回**同名** helper —— 于是 switch 主体一个字都不用改（搬迁风险压到最低）。
 *
 * ⚠️ 搬迁验收：同一份 map.json 下，新旧二进制的**动词输出逐字节一致**（读取侧不参与索引构建，
 * 所以不能用产物哈希验收，要用 stdout 对拍）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHubModel, hubNormTable, loadHubConfig } from './repoctx-hub.mjs'

/** 产物契约版本：跨版本读取必须显式失败（缺字段的旧产物会给出看起来正常的错答案，比报错危险得多） */
export const SCHEMA = 'repoctx/2'

/** XML 属性/文本转义：源码标识符、路径、任务文本、笔记文本都可能带 " < > &，
 *  不转义会产出畸形输出（实测 `for "x"` 输出 task=""x"" 双引号嵌套）。所有标签插值点必须走这里。 */
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// 任务透镜的词频权重（读取侧：只影响 for 的排序）
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


  // ── 检索与渲染 ────────────────────────────────────────────────────────────
  function tokenize(text) {
    return (text.toLowerCase().match(/[\p{L}\p{N}_$]{2,}/gu) || [])
  }

  function loadMap() {
    if (!fs.existsSync(MAP_FILE)) {
      console.error(`✗ 还没有索引：先跑  node repoctx.mjs index --repo "${REPO}"`)
      process.exit(2)
    }
    const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
    // 版本护栏（P2-4）：旧产物缺 typeEdges/imports/新 kind，静默读下去会给出**看起来正常**的错答案
    if (m.schema !== SCHEMA) {
      console.error(`✗ 产物版本不符（磁盘 ${m.schema || '无'} ≠ 当前 ${SCHEMA}）：请重跑  node repoctx.mjs index --repo "${REPO}"`)
      process.exit(2)
    }
    return m
  }

  // ── 人工笔记（记忆体的"人写那一半"）─────────────────────────────────────────
  // 与 map.json 的分工：map.json 是**从源码派生**的机器事实（可重建、可 0 漂移校验、不含时间戳）；
  // notes.jsonl 是**人/agent 写下的经验**（追加式、带日期、不可重建）。
  // 两者都落在 .repoctx/ 下，由 `context` 动词合成一个视图——这就是"一份仓库记忆体"。
  function readNotes() {
    if (!fs.existsSync(NOTES_FILE)) return []
    return fs.readFileSync(NOTES_FILE, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] } // 坏行跳过：笔记文件不该因一行损坏而整体不可用
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
  /** 调用图默认排除 prov=doc 的边（文档"提到"不等于"调用"）；--include-docs 可放开 */
  function callEdges(map) {
    return INCLUDE_DOCS ? map.edges : map.edges.filter((e) => e.prov !== 'doc')
  }
  /**
   * **缓存键**（2026-09-16 审核 P2-2）：以前下游缓存只用"长度"做键，同长度不同内容会命中脏缓存
   * （单命令进程里不会发生，但同进程多次 `loadMap` 不同仓库时会静默拿到上一个仓库的排名/枢纽分）。
   * 取 O(1) 可得、且**覆盖所有影响下游的维度**：符号数 / 调用边数 / 类型边数 / 歧义组数 + 文档边开关。
   */
  const mapKey = (map) => `${map.symbols.length}|${map.edges.length}|${(map.typeEdges || []).length}|${Object.keys(map.ambRefs || {}).length}|docs=${INCLUDE_DOCS ? 1 : 0}`

  function pagerankOf(map) {
    const k = mapKey(map)
    if (!_rank || _rank.k !== k) {
      _rank = { k, r: pagerank(map.symbols.length, callEdges(map)) }
    }
    return _rank.r
  }

  let _adjs = null
  /**
   * **邻接索引**（2026-09-16 审核 P2-5）：`inDegree`/`calleesOf` 原本每次全量 filter（O(E)），
   * 而 `symLine` **每输出一行就调一次 inDegree** → `export`/`tree`/`hubs` 全量输出是 O(N×E)
   * （本仓 N≈8.5k、E≈8.6k ≈ 7×10⁷ 次比较）。改为一次 O(E) 预构建入度表 + 出边表，之后 O(1)。
   */
  function adjacencyOf(map) {
    const k = mapKey(map)
    if (_adjs && _adjs.k === k) return _adjs
    const edges = callEdges(map)
    const inDeg = new Int32Array(map.symbols.length)
    const out = new Map() // from → [to]
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
  /**
   * 枢纽模型（带缓存）：符号数 / 边数 / 配置指纹任一变化就重建。
   *
   * 同时预算一份**归一化得分表** `norm`（0..1，按全库最高分归一）供 `for` 的排序使用。
   * 归一化是必须的：枢纽原始分是"加权入度"量级（本仓库最高 288），直接进词频排序会反客为主。
   */
  function hubModelOf(map) {
    const cfg = loadHubConfig(OUT_DIR)
    // 缓存键含 map 内容指纹（P2-2）+ 配置源与白名单（白名单会影响泛用名降权）
    const key = `${mapKey(map)}|${cfg.source || 'default'}|${(cfg.whitelist || []).join(',')}`
    if (!_hub || _hub.key !== key) {
      const model = createHubModel({ symbols: map.symbols, edges: callEdges(map), config: cfg })
      // 归一化交给 hub 模块（可单测）。注意不能用"除以最高分"：枢纽分重尾，实测那样会让
      // `for` 里满屏 hub="0.000"，等于没接进去；hubNormTable 内部用 log1p，有效区间 0.1-0.8。
      const { norm, max } = hubNormTable(model.ranking(), map.symbols.length)
      _hub = { key, model, cfg, norm, max }
    }
    return _hub
  }
  /** 歧义组：同名定义 >1 —— 对外只展示每组一条，展开才列候选（`repoctx amb NAME`） */
  function ambGroupsOf(map) { return hubModelOf(map).model.ambGroups(map.ambRefs || {}) }

  /**
   * 文档段落符号（markdown 标题，`t === 'sec'`）。
   *
   * 它们不是代码名：与代码名撞名**不构成"代码歧义"**。实测教训（2026-09-16）：
   * `触发条件` 有 7 个定义 / 80 次引用，**全部**来自 `skills/*.md` 的中文小标题，
   * 却和 `name`/`content` 这类代码名同榜，把真正的代码歧义挤下去——照它去"治理重名"是白费功夫。
   * hub 侧本来就不选文档段落当枢纽（`score()` 里 `t === 'sec' || t === 'doc'` 直接返回 null），
   * 这里把**同一口径**给到歧义账本，两处不再各说各话。
   */
  const isDocSymbol = (s) => !!s && (s.t === 'sec' || s.t === 'doc')
  /** 该组里有多少个定义来自文档段落 */
  function docCountOf(map, g) { return g.idxs.reduce((n, i) => n + (isDocSymbol(map.symbols[i]) ? 1 : 0), 0) }
  /** 纯文档组：全部定义都是文档段落 → 与代码无关 */
  const isDocOnlyGroup = (map, g) => g.idxs.length > 0 && docCountOf(map, g) === g.idxs.length
  /**
   * 歧义账本的**默认视图**：隐藏纯文档组（`--docs` 可放开）。返回 { all, code, hidden }，
   * 让调用方既能只列代码组，也能在头部披露"隐藏了多少"（不做静默过滤——静默过滤是缺陷来源）。
   */
  function codeAmbGroups(map) {
    const all = ambGroupsOf(map)
    const code = all.filter((g) => !isDocOnlyGroup(map, g))
    return { all, code, hidden: all.length - code.length }
  }
  /** 把一组检索结果**按名字收敛**（保留得分最高者），并标注同名定义数 */
  function collapseRows(map, rows) {
    const best = new Map()
    for (const r of rows) {
      const cur = best.get(r.s.n)
      if (!cur || r.score > cur.score) best.set(r.s.n, r)
    }
    return [...best.values()].map((r) => ({ ...r, ambCount: hubModelOf(map).model.sameNameCount(r.s.n) }))
  }


  /** 传递闭包（in-edges）= 改动爆炸半径。返回按 PageRank 降序的索引数组。 */
  function impactDetail(map, idx, depth, { types = false } = {}) {
    const incoming = new Map() // to → [{ from, fam }]（fam = 边族：call | type）
    const add = (e, fam) => {
      if (!incoming.has(e.to)) incoming.set(e.to, [])
      incoming.get(e.to).push({ from: e.from, fam })
    }
    for (const e of callEdges(map)) add(e, 'call')       // 先加调用边 → 同一对两端兼有时"调用"优先标注
    if (types) for (const e of map.typeEdges || []) add(e, 'type')
    const via = new Map() // node → 首次到达它的边族
    let frontier = [idx]
    for (let d = 0; d < depth; d++) {
      const next = new Set()
      const pending = new Map() // 本轮首次到达（避免同轮内被后到的边覆盖族标注）
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
  /** 反向闭包（调用图）。`opts.types = true` 时纳入类型引用边（--types：类型改动的爆炸半径） */
  const impact = (map, idx, depth, opts) => impactDetail(map, idx, depth, opts).list

  function resolveSymbol(map, name) {
    if (name === undefined || name === null || name === '') {
      // 此前裸跑 `repoctx symbol` 会一路走到 name.toLowerCase() 抛未捕获 TypeError（实测）；
      // symbol/callers/callees/impact/context 五个动词共用本入口，一处守卫全覆盖
      console.error('用法：repoctx <symbol|callers|callees|impact|context> <NAME> [flags]')
      process.exit(2)
    }
    const hits = map.symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.n === name)
    if (!hits.length) {
      const fuzzy = map.symbols.map((s, i) => ({ s, i })).filter(({ s }) => s.n.toLowerCase().includes(name.toLowerCase()))
      if (!fuzzy.length) { console.error(`✗ 找不到符号：${name}`); process.exit(3) }
      // ⚠️ 模糊命中必须**自我披露**（2026-09-16 审核 P2-3）：调用方（symbol/callers/callees/impact/context）
      // 全都取 `hits[0]` 当"目标"，静默使用近似名会让用户以为拿到的是精确结果——实测场景：
      // 输入 `cfg` 想看 `Cfg`，输出格式完全正常、毫无提示，闭包却是另一个符号的。
      console.log(`<!-- 精确名未命中：「${name}」按**子串模糊匹配**返回前 ${Math.min(fuzzy.length, 10)} 条；以下输出（含闭包）基于其中第一条，请核对 -->`)
      return fuzzy.slice(0, 10)
    }
    return hits
  }

  function symLine(map, i, extra = '') {
    const s = map.symbols[i]
    const rank = pagerankOf(map)[i] || 0
    // q= 限定名（仅 AST 模式有，无容器时省略）：同名候选靠它区分——
    // `SkillCatalog::is_empty` vs `Vec::is_empty`。**只用于展示，不参与打分。**
    const q = s.q ? ` q="${esc(s.q)}"` : ''
    // cxOwn（自身分支数 = cx − 嵌套定义的 cx）与 cx 不同时才显示——两者相等即无嵌套，噪声省略
    const cxOwn = s.cxOwn != null && s.cxOwn !== s.cx ? ` cxOwn="${s.cxOwn}"` : ''
    return `<s t="${s.t}" n="${esc(s.n)}"${q} p="${esc(s.p)}" l="${s.l}" cx="${s.cx}"${cxOwn} in="${inDegree(map, i)}" rank="${rank.toFixed(4)}"${extra}>${esc(s.sig)}</s>`
  }

  /**
   * in-edges 类结果的**置信度自我标注**（`callers` / `impact` / `context` 共用同一份逻辑，避免各写一套后漂移）。
   *
   * 返回 ` conf="..." reason="..."` 或空串。两种情况会让结果**看起来精确但不可信**，必须自己说出来：
   *   ① **歧义名**（同名多处定义）→ 引用一律不连边（宁缺毋滥）⇒ **n=0 不代表无人使用**
   *      （这是最危险的空结果："看起来没人依赖它"，实际是"我们拒绝猜"）；
   *   ② **泛用名** → 名字级匹配会把同名 stdlib 调用也算进来（实测抽查 `is_empty` 的 5 个调用方仅 1 个指向本定义）。
   *
   * 三个边界：白名单里的名字视为**已认领**，不标泛用；`callees` **不调用**它（其正确性不取决于目标名唯一性）；
   * 属性名用 `reason=` 而非 `note=`（`impact` 头部已有 `note`，撞名会产生**重复属性**）。
   * ⚠️ 这是**标注不是修复**：根因（同名消歧）需要类型解析，即 LSP/SCIP 那条路。
   */
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

  function estTokens(text) { return Math.ceil(text.length / 4) }

  return {
    loadMap, readNotes, callEdges, pagerankOf, inDegree, calleesOf, hubModelOf, ambGroupsOf, collapseRows,
    isDocSymbol, docCountOf, isDocOnlyGroup, codeAmbGroups,
    symLine, confNote, resolveSymbol, impactDetail, impact, lensFor, tokenize, estTokens,
  }
}
