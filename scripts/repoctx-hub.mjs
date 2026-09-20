/**
 * repoctx-hub —— 枢纽打分与**分级过滤**（第三轮：不搞一刀切）
 *
 * 为什么独立成模块：这些规则会被反复调参（黑名单该放谁、测试打折打多少），
 * 单独成文件后既能单测，也不必每次动主索引器。
 *
 * 三级策略（关键：**降权 ≠ 删除**）：
 *   ① 全局高频泛用名（`push`/`len`/`json`…）→ **降权**（默认 ×0.15）。边保留、仍可 callers/impact 查，
 *      只是不再霸占枢纽榜。业务里真以 `push` 为核心的实现，可进白名单恢复权重。
 *   ② 标准库 / 第三方路径（vendor、node_modules、third_party、registry…）→ **直接过滤**，不进候选。
 *   ③ 项目白名单（`.repoctx/config.json` 的 `hub.whitelist`）→ 恢复权重。
 *
 * 多特征打分（替代"纯引用计数"）：
 *   score = 归一化入度 × 类型权重 × 路径权重 × 泛用名系数 × 跨度系数 × 跨文件广度
 *   归一化入度 = 加权入度 / 同名定义数 —— 名字越泛滥，哪怕总调用量高也会被压下去。
 *   每个因子都能打印（`hubs --explain`），避免变成黑箱。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 一级：全局高频泛用名 —— 命中即**降权**，绝不删除 */
export const GENERIC_NAMES = new Set([
  // —— 用户给定清单 ——
  'len', 'push', 'pop', 'is_empty', 'empty', 'kind', 'new', 'from_json', 'to_json', 'json', 'parse',
  'serialize', 'deserialize', 'get', 'set', 'add', 'remove', 'update', 'create', 'delete',
  // —— 实测补充（本仓库枢纽榜曾被它们占满：is_empty 253 / json 226 / push 181 / kind 163 / len 150）——
  'as_str', 'to_string', 'clone', 'default', 'unwrap', 'collect', 'iter', 'iter_mut', 'map', 'filter',
  'find', 'insert', 'contains', 'from', 'into', 'main', 'init', 'next', 'some', 'ok', 'err', 'format',
  'print', 'log', 'run', 'index', 'count', 'items', 'keys', 'values', 'entry', 'first', 'last',
  'text', 'path', 'file', 'read', 'write', 'open', 'close', 'data', 'value', 'name', 'type', 'size',
  'string', 'number', 'boolean', 'object', 'array', 'status', 'message', 'args',
])

/** 二级：第三方 / 依赖目录 —— 直接过滤（这些路径下的定义不该进本仓库的枢纽榜） */
export const VENDOR_PATH = /(^|\/)(node_modules|vendor|third_party|thirdparty|external|extern|\.cargo|registry|site-packages|dist-packages|Godeps)(\/|$)/

/** 测试 / 样例路径 —— 引用打折、候选打折（测试代码的引用不等于生产依赖） */
export const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|samples?|bench|benchmarks?)(\/|$)|\.(test|spec|_test|_spec)\.[a-z]+$/i

/** 符号类型权重：局部变量已在候选阶段剔除，这里处理"非局部但次要"的类型 */
export const KIND_WEIGHT = {
  fn: 1, method: 1, class: 1, iface: 1, struct: 1, enum: 1, trait: 1,
  impl: 0.9, type: 0.9, macro: 0.85, const: 0.8, mod: 0.7, var: 0.4,
  // 成员类（第四十九轮补入的符号）：**显式 0**，不是靠兜底的 0.5。
  // 它们不是可调用目标（调用图里不可能有指向它们的边，见 repoctx.mjs MEMBER_KINDS），
  // 也不该因将来某个新边族拿到入度而混进枢纽榜——给 0 是把"不该上榜"写成数据。
  field: 0, prop: 0, variant: 0,
  other: 0.5, sec: 0, doc: 0,
}

export const DEFAULT_CONFIG = { whitelist: [], genericDamp: 0.15, testDamp: 0.5, vendorDamp: 0.2 }

/**
 * 读项目配置（可选）：`.repoctx/config.json`
 * ```json
 * { "hub": { "whitelist": ["push"], "genericDamp": 0.15, "testDamp": 0.5, "vendorDamp": 0.2 } }
 * ```
 * 读不到就用默认值——**配置缺失不是错误**，只是少了白名单。
 */
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
    // 配置坏了要说出来，不能静默退回默认（否则用户改了白名单却不生效，无从察觉）
    return { ...DEFAULT_CONFIG, source: file, error: e.message }
  }
}

export const isVendorPath = (p) => VENDOR_PATH.test(p)
export const isTestPath = (p) => TEST_PATH.test(p)

/**
 * 行级模式的"弱引用"清理：去掉注释与字符串字面量。
 *
 * AST 模式不需要它（注释/字符串在语法树里根本不是 identifier 节点）；
 * 但只要回落到行级（AST 未安装），这一步就是**性价比最高**的降噪：
 * `prov=name` 的噪声有相当一部分来自"文档/注释里恰好写了同名符号"。
 */
export function stripNoise(text, lang) {
  let t = text
  if (lang === 'py') t = t.replace(/#[^\n]*/g, ' ')
  else t = t.replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
  // 行注释：`[^:]` 前置避免吃掉 http:// 里的 //
  t = t.replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ')
  // 正则字面量（ts/js，2026-09-16 字符级测试抓到的真 bug）：`/["']/g; real_call(); const t = "x"`
  // 里正则的引号会"开始一个字符串"，把 real_call 连同后面代码**整段吞掉**。
  // `(?!\s)` 区分除法（`a / b / c` 开启符后是空格 → 跳过）；前缀捕获保留，避免误伤 URL / `</div>`。
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    t = t.replace(/((?:^|[=(,:;[!&|?{]|\breturn)\s*)\/(?!\s)(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g, '$1/RE/')
  }
  t = t.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')        // 双引号串
  // 单引号：**Rust 里只可能是字符字面量**（`'{'` / `'\''`）——生命周期 `'a` 必须原样保留，
  // 否则通用 `'…'` 规则会吃掉 `fn f<'a>(needle: &'a str)` 的 `>(needle: &`（实测：参数名被吞）。
  t = lang === 'rust'
    ? t.replace(/'(?:\\.|[^'\\\n])'/g, "''")
    : t.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  t = t.replace(/`(?:[^`\\]|\\.)*`/g, '``')          // 模板串
  return t
}

/**
 * 建立打分模型。
 * @param symbols 全部符号（含 `local` 标记：局部变量不进候选）
 * @param edges   参与打分的有向边（调用方传已过滤 doc 边的集合）
 * @param config  loadHubConfig() 的结果
 */
export function createHubModel({ symbols, edges, config }) {
  const sameName = new Map()   // 名字 → 定义数（归一化用）
  for (const s of symbols) sameName.set(s.n, (sameName.get(s.n) || 0) + 1)

  const incoming = new Map()   // 目标 → 引用方列表
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    incoming.get(e.to).push(e.from)
  }

  const whitelist = new Set(config.whitelist || [])

  /** 单点打分；返回 null = **不进候选**（局部变量 / 文档段落 / vendor 路径 / 无入度） */
  function score(i) {
    const s = symbols[i]
    if (!s) return null
    if (s.t === 'sec' || s.t === 'doc') return null   // 文档段落不是枢纽
    if (s.local) return null                          // 局部变量不进候选（用户要点：解决局部 var 上榜）
    if (isVendorPath(s.p)) return null                // ② 第三方路径直接过滤

    const inc = incoming.get(i) || []
    if (!inc.length) return null

    // 加权入度：同文件引用打折（同文件 ≠ 跨模块依赖）、测试目录引用打折
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
    const norm = win / amb                                   // 归一化：同名定义越多越压低
    const k = KIND_WEIGHT[s.t] ?? 0.5
    const pw = isTestPath(s.p) ? config.testDamp : 1
    const nw = whitelist.has(s.n) ? 1 : (GENERIC_NAMES.has(s.n) ? config.genericDamp : 1)
    const span = (s.el && s.l) ? (s.el - s.l + 1) : 1
    const sw = span < 3 ? 0.7 : 1                            // 单行小工具降权
    const bw = callerFiles.size >= 3 ? 1.15 : callerFiles.size === 2 ? 1 : 0.85  // 跨文件广度

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

  /** 枢纽榜（降序，确定性排序） */
  function ranking(limit = Infinity) {
    const rows = []
    for (let i = 0; i < symbols.length; i++) {
      const f = score(i)
      if (f) rows.push({ i, s: symbols[i], ...f })
    }
    rows.sort((a, b) => b.score - a.score || a.s.n.localeCompare(b.s.n) || a.i - b.i)
    return rows.slice(0, limit)
  }

  /** 歧义组：同名定义 >1 的符号归为一组（对外只展示 1 条，展开才列候选） */
  function ambGroups(ambRefs = {}) {
    const byName = new Map()
    symbols.forEach((s, i) => {
      if (!byName.has(s.n)) byName.set(s.n, [])
      byName.get(s.n).push(i)
    })
    const out = []
    for (const [name, idxs] of byName) {
      if (idxs.length < 2) continue
      // ⚠️ hasOwn 而不是 `ambRefs[name] || 0`：产物经 JSON 往返后是普通对象（带原型），
      // 组名撞上 Object.prototype 的键（constructor/toString/…）会读出函数而非计数 —— 实测踩过。
      const refs = Object.hasOwn(ambRefs, name) ? ambRefs[name] : 0
      out.push({ name, idxs, refs, vendorOnly: idxs.every((i) => isVendorPath(symbols[i].p)) })
    }
    out.sort((a, b) => b.refs - a.refs || b.idxs.length - a.idxs.length || a.name.localeCompare(b.name))
    return out
  }

  /**
   * 把一组榜单**按歧义组收敛**：同名只保留得分最高的一条，并带上 amb 数。
   * 这样 7k 条同名歧义不会刷屏，但歧义本身不丢（`amb NAME` 可展开）。
   */
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

/**
 * 归一化得分表（0..1），供 `for` 的排序把枢纽分接进去。
 *
 * 为什么用 **log1p** 而不是"除以最高分"：枢纽分是**重尾分布**（本仓库最高 288，中位数个位数）。
 * 线性归一后长期尾部会被压到 0.00x —— 实测 `for` 里满屏 `hub="0.000"`，等于没接进去。
 * log1p 把头部压扁、把尾部抬起（本仓库 max=288 时：hub=1 → 0.12、hub=10 → 0.42、hub=100 → 0.81），
 * 这样"中等重要的枢纽"才能真正参与同分排序，而不是只有前十名有效。
 */
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
