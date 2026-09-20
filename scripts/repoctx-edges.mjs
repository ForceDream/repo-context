/**
 * repoctx-edges —— **图构建层**（从 repoctx.mjs 切出，2026-09-16 审核 P2-1 拆分）
 *
 * 职责：把"符号 + 导入别名"变成**三类边**，全部零推断、宁缺毋滥：
 *   · 调用边 `edges`（唯一名 / 同文件词法 / 可见性 / 限定名 qname / 别名兜底 / 同文件撞名）
 *   · 类型边 `typeEdges`（类型位引用 × 类型定义，**与调用图物理分离**）
 *   · 派发表 `dispatchOf`（trait→impl，仅供 impact 做过近似展示）
 *
 * 为什么独立成模块：① repoctx.mjs 已 1400 行（god-file），这是其中最**自足**的一块
 * （依赖只有 node:path + hub 的 isVendorPath/stripNoise + files 的 LANG_BY_EXT）；
 * ② 它是全项目最需要逐条复核的逻辑（每条规则都对应一次实测结论），单独成文件后可被更细地单测。
 *
 * ⚠️ 搬迁的验收标准：**同一外部语料**上 `index` 产物逐字节不变（纯搬迁，不改语义）。
 * 教训：本仓不能用来自验——skill 源码自己也在被索引，搬迁必然改变 map.json。
 */
import path from 'node:path'
import { isVendorPath, stripNoise } from './repoctx-hub.mjs'
import { LANG_BY_EXT } from './repoctx-files.mjs'

/**
 * 语言族：**同名跨语言不可能是同一符号**（TS 代码绑不到 Rust 符号）。
 * 实测：大型混合技术栈仓库里，跨语言同名边中相当比例是纯噪声
 * （如某前端组件名恰好等于另一语言的符号名），代码里没有任何机制能让前端调用 Rust 同名字符号。
 * md 文档段落（family='other'）**豁免**：文档提到任何语言的符号都是合理的（doc 边不进调用图）。
 */
export const langFamily = (p) => (p.endsWith('.rs') ? 'rs' : (/\.(ts|tsx|js|jsx|mjs)$/.test(p) ? 'ts' : 'other'))

/**
 * 成员类符号：**字段 / 接口属性 / 枚举变体**（2026-09-16 第四十九轮补入声明层的那批）。
 *
 * 它们是符号（`symbol`/`for`/`typerefs`/`imports` 都能查），**但不参与调用图的名字解析**：
 * ① 语义上它们不是可调用目标——裸名 `data` 在表达式里指的是局部变量，不是某个接口的 `data` 成员；
 * ② 实测代价极大：放任它们进候选池，未连歧义从 2,147 暴涨到 10,382（+8,235），
 *    因为 `data`/`id`/`name`/`error` 这类成员名在仓库里成百上千处重名 —— 噪声会淹掉真信号。
 * 于是它们只服务"结构/类型面"的查询，不进调用图。
 */
export const MEMBER_KINDS = new Set(['field', 'prop', 'variant'])

/**
 * 导入别名 / re-export 链扫描：`use a::b::Foo as Bar`、`use a::{Foo as Bar, Baz}`、
 * `import { Foo as Bar } from '…'` → 返回 Map(别名 → 原名)。
 * 只用**源码显式声明**（确定性，非推断）；glob（`use x::*` / `export *`）跳过——
 * 它需要模块→文件映射，收益与风险都不划算（实测全仓 2 处）。
 * 实测全仓别名现在只有个位数，但它是会随代码演进增长的确定性事实，接上零维护成本。
 */
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

export function buildEdges(symbols, aliases) {
  // 名字 → 定义位置；唯一才连边（多处定义只计数 + 聚组，不猜）
  const byName = new Map()
  symbols.forEach((s, i) => {
    if (!byName.has(s.n)) byName.set(s.n, [])
    byName.get(s.n).push(i)
  })
  const edges = []
  let ambiguous = 0
  // 候选**全是函数局部 var/const**（local===true）的引用：不可能是 API 引用（函数局部名不可能被跨符号引用），
  // 单列计数、不计入歧义。实测本仓库 200 个名字 / 3394 条（占歧义引用 61.7%）——把"5500 条歧义"这个
  // 误导性头条数字变成"2100 条真歧义 + 3400 条函数局部引用"。**不改边**：不做 blanket 排除，
  // 因为实测 blanket 排除会让 28 个混合候选集（462 条）只剩一个**错误**目标（logout→auth.rs 的 fn、
  // filename→mod、source→方法），且会误杀前端真实 API（`export const useAuthStore = …` 是 kind=var）。
  let localOnly = 0
  const allLocalVarConst = (arr) => arr.every((j) => (symbols[j].t === 'var' || symbols[j].t === 'const') && symbols[j].local === true)
  // 名字 → 被跳过的歧义引用次数（歧义组排序用，进产物）。
  // ⚠️ 必须用无原型对象：符号名是用户可控的，仓库里真有叫 `constructor` 的符号 ——
  // 普通对象上 `ambRefs['constructor']` 会读到 Object.prototype.constructor（实测踩过，
  // amb 输出里 refs 变成 "function Object() { [native code] }11"）。
  const ambRefs = Object.create(null)
  const TOKEN_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu
  symbols.forEach((s, i) => {
    const seen = new Set()
    // AST 模式用抽取期算好的引用集（已排除注释/字符串/局部变量）；
    // 行级模式先剥掉注释与字符串再分词 —— "过滤弱引用"里性价比最高的一步，
    // 行级模式的噪声大头正是"注释/文档里恰好写了同名符号"。
    const langHint = LANG_BY_EXT[path.extname(s.p).toLowerCase()] || ''
    const tokens = s.refs || (stripNoise(s.body || '', langHint).match(TOKEN_RE) || [])
    // ── 限定调用消解（`Foo::bar` → 候选 q 前缀匹配，2026-09-16 第三十六/七轮）──────
    // 调用点显式写明作用域路径 = 纯名字级事实（非统计、非推断）：`Foo::bar` 只可能指向 Foo 域内的 bar。
    // 匹配：候选 q === `${path}::${name}` 或以其结尾（源码路径可能比定义处容器链短，用后缀对齐；
    // crate/self/super 前缀先剥掉）。**无 q 匹配不回落裸名**——限定路径已说明意图，多半指向外部
    // crate（`String::from`/`Array.from` 类），裸名回落会把 stdlib 调用错连到项目里唯一的同名定义
    // （这类假边今天存在，严格模式顺带消灭它们）。消解过的名字加入 seen，裸名循环跳过
    // （同一调用不再"既计数歧义又连边"）。行级模式无 qrefs → 整段静默缺席。
    const qResolved = new Set()
    for (const qr of s.qrefs || []) {
      if (qr.name === s.n || qr.name.length < 3 || seen.has(qr.name)) continue
      seen.add(qr.name)
      let p = qr.path
      while (/^(crate|self|super)::/.test(p)) p = p.replace(/^(crate|self|super)::/, '')
      const full = `${p}::${qr.name}`
      const defs0 = byName.get(qr.name)
      if (!defs0 || !defs0.length) continue
      const defs = defs0.filter((j) => !MEMBER_KINDS.has(symbols[j].t)) // 成员不参与调用解析（见 MEMBER_KINDS）
      if (!defs.length) continue
      const usable = defs.filter((j) => {
        if (j === i || isVendorPath(symbols[j].p)) return false
        const q = symbols[j].q
        // ① 限定名匹配：相等 / 源码路径比定义处容器链短（后缀）/ 长（crate:: 前缀未剥尽时反向后缀）
        if (q === full || (!!q && (q.endsWith(`::${full}`) || full.endsWith(`::${q}`)))) return true
        // ② 自由函数（无容器链 → q 缺失）经模块路径调用：`spill::save_text`。
        //    Rust 惯例 mod 名 = 文件名（X.rs / X/mod.rs），用文件名对齐；仅限 .rs 候选（qrefs 本就只来自 rust）。
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
      // 别名兜底：裸名查不到定义时，看本文件是否用 `use … as` / `import { … as … }` 引进了它。
      // 别名是源码显式声明（确定性）；指向的原名才是有定义的符号。
      let viaAlias = false
      let defs = byName.get(tk)
      if ((!defs || !defs.length) && aliases) {
        const al = aliases.get(s.p)
        const orig = al && al.get(tk)
        if (orig) { defs = byName.get(orig); viaAlias = !!(defs && defs.length) }
      }
      if (!defs || !defs.length) continue
      // 成员类符号不参与调用图的名字解析（它们是符号，但不是可调用目标；见 MEMBER_KINDS 注释）。
      defs = defs.filter((j) => !MEMBER_KINDS.has(symbols[j].t))
      if (!defs.length) continue
      // ② 二级过滤：可用定义只在第三方/vendor 路径 → 不连边（依赖的依赖不算本仓库的依赖）。
      // 注意：**泛用名不再在这里断边**（老的 UBIQUITOUS 一刀切已废弃）——
      // 改由打分阶段降权，这样业务里真叫 push 的核心实现仍可被 callers/impact 查到。
      // 语言族过滤：TS↔Rust 同名不是同一符号（md 段落豁免，见 langFamily 注释）。
      // 与 qname/dispatch 的精度无关，是**纯修正**：此前裸名匹配跨语言连边，实测 1591 条 name 假边。
      const f1 = langFamily(s.p)
      const usable = defs.filter((j) => {
        if (j === i || isVendorPath(symbols[j].p)) return false
        // impl 块**不是可被引用的名字**（它是容器，且名字取自定义类型）——任何候选集里的 impl
        // 都不可能是目标。实测（2026-09-16）：本仓库 177 条歧义引用（占残余 8.8%）的干扰候选
        // 全是同名 impl 块（`struct X` + `impl X` 同文件两份），剔掉即唯一。
        // 这是"符号可引用性"维度（v7 提案点出的方向），比它的角色/命名空间过滤便宜且收益大得多。
        if (symbols[j].t === 'impl') return false
        const f2 = langFamily(symbols[j].p)
        return f1 === 'other' || f2 === 'other' || f1 === f2
      })
      if (!usable.length) continue
      if (usable.length > 1) {
        // 分层消歧 L2（2026-09-15，吸收自外部提案 v2 的"作用域匹配"层）——**窄规则，勿放宽**：
        // 仅当 ① 全部候选都是 fn/method 且跨文件（真 API 撞名；局部变量组即使"解对"，边也指向
        //    非 API 符号，没有价值；泛用名组的指涉多半是 stdlib，根本不在候选里），
        //    ② 撞名规模 <= 3（大簇是 trait 方法实现簇，同文件有 impl 不代表调用指向它——可能是
        //    动态派发，宁缺毋滥），③ 本文件恰好一个候选。
        // 可靠性由语言事实背书：Rust/TS 同文件重复声明同名项会编译报错。
        // 实测该规则消解 136 条引用（占真撞名桶 579 条的 23%），样例全部为真消歧
        // （两个前端副本的 ErrorBoundary 各自引用自己的 componentDidCatch/constructor 等）。
        const sameFile = usable.filter((j) => symbols[j].p === s.p)
        const realCollision = usable.every((j) => symbols[j].t === 'fn' || symbols[j].t === 'method')
          && new Set(usable.map((j) => symbols[j].p)).size > 1
        // ⚠ 文档段落作引用源时**不参与** R1/R3/R2：它们是**代码作用域**规则，而文档没有词法作用域。
        // 实测反例（2026-09-16 ④ 测量）：md 里 `# 标题` 的段落引用 `## 子标题`，R3 把这种**文档结构**
        // 标成 prov="lexical"；而 callEdges 只排除 prov="doc" ⇒ 文档边混进了调用图
        // （callers/impact 里出现"文档标题之间的调用"）。让文档源落到末尾"歧义不连边"分支，
        // 既不放宽也不污染；唯一候选的情形本就在下方 `usable[0]` 分支标 prov="doc" ✓。
        if (s.t !== 'sec' && realCollision && usable.length <= 3 && sameFile.length === 1) {
          edges.push({ from: i, to: sameFile[0], prov: 'scope-unique' })
          continue
        }
        // R3 lexical（2026-09-16）：**词法作用域优先**——本文件恰有一个候选，且它是顶层声明（q 缺失）
        // 且非 var/const（指局部变量类的边第三十一轮判定无价值）。不限制撞名规模与类型分布，
        // 因此覆盖 scope-unique 之外的场景。语言事实：同文件顶层同名项遮蔽外来名（Rust/TS 一致）。
        if (s.t !== 'sec' && sameFile.length === 1) {
          const c = symbols[sameFile[0]]
          if (!c.q && c.t !== 'var' && c.t !== 'const') {
            edges.push({ from: i, to: sameFile[0], prov: 'lexical' })
            continue
          }
        }
        // R2 visibility（2026-09-16，保守版）：跨文件"唯一可见"候选。
        //   TS：未 export 的符号在别的文件**不可见**（语言铁律）；
        //   Rust：pub 可见；私有项对其模块子树可见 → 用路径前缀近似，**可能可见即视为可见**；
        //   可见性未知（行级模式 exp===undefined）→ 视为可见 → 该条不消解（绝不误删）。
        // 目标排除同文件（那是 R3 的地盘）与局部变量。
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
        if (allLocalVarConst(usable)) { localOnly++; continue } // 函数局部引用：单列不计歧义（见上方注释）
        ambiguous++
        ambRefs[tk] = (ambRefs[tk] || 0) + 1
        continue
      }
      const j = usable[0]
      // 文档段落里的标识符只是"提到"，不是"调用"——单独标 prov="doc"。
      // 不区分的话，README/设计文档会把调用图淹掉（实测 callers runRules 里混进 6 个文档标题）。
      const prov = viaAlias ? 'alias' : (s.t === 'sec' ? 'doc' : (symbols[j].p === s.p ? 'same-file' : 'name'))
      edges.push({ from: i, to: j, prov })
    }
  })
  // 注：文件内证据传播（同文件已确定绑定 → 同文件其余同名引用）已于 2026-09-16 实测并**回退**：
  // 本仓库只多解 4 条（阈值 <50 即放弃）。原因是结构性的——lexical/visibility/唯一名三条规则
  // 本就对"同一文件 + 同一候选集"给出相同结论，文件内再传播没有额外信息；4 条来自按**出现点**
  // 判定的 qname 例外。详见 MEMORY 第四十四轮。
  /**
   * ── 类型边族（`typeEdges`，2026-09-16 第四十九轮）────────────────────────────
   *
   * 数据源是抽取器的 `trefs`（类型位上的类型名：`x: Foo`、`Vec<Bar>`、`impl Trait for Type`、
   * 结构体字段类型、泛型实参…）。**与调用图物理分离**是本族的立足点：
   * 类型引用**不是调用**——拆族前 `type_identifier` 混在 refs 里，于是 `pub cfg: Config`
   * 会在调用图里连出一条 Cfg→Config 的"调用"边，直接污染 `callers`/`impact` 的精度。
   * 拆族后信息没丢：类型引用改由 `typerefs` 动词查询（"谁引用了它 / 它引用了谁"）。
   *
   * 解析规则（与调用图同源的宁缺毋滥，零推断）：
   *   候选 = 同名定义里 kind 属于 TYPE_KINDS 的，且**同语言族**（前端类型绑不到 Rust 同名类型）；
   *   唯一 → 连边；多个 → 先看"本文件唯一"（词法遮蔽，语言事实）；仍不唯一 → 计入 `ambTypes`（不猜）。
   */
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
/**
 * trait→impl 派发表（静态、确定性、零推断）：trait 方法符号 idx → 各 impl 中同名方法的 idx 集合。
 *
 * 这是**动态派发候选集**——`call`×28 这类 trait 实现簇的语义本相就是多目标，
 * 所以它**不进精确调用图**（宁缺毋滥不变、callers 不受影响），只供 `impact` 做过近似展示：
 * 影响面分析要的本来就是"可能被波及的全部"，而非"唯一确定的那一个"。
 *
 * 构建（全部来自现有抽取产物，无新解析）：trait 符号 span 内的 fn/method = trait 方法；
 * `impl <tr> for Type`（tr 字段，AST 模式才有）span 内的同名 fn/method = 实现方法，按 (trait 名, 方法名) 配对。
 * 行级模式无 tr 字段 → 表为空 → dispatch 特性静默缺席（降级，不报错）。
 */
export function dispatchOf(map) {
  if (_disp && _disp.key === map.symbols.length) return _disp.t
  const syms = map.symbols
  const isM = (s) => s.t === 'fn' || s.t === 'method'
  const inSpan = (host, s) => s.p === host.p && s.l > host.l && s.el <= host.el
  // trait 名 → (方法名 → trait 方法 idx)。Rust 无重载，同名取首个即异常自愈。
  const traitMethods = new Map()
  syms.forEach((s, i) => {
    if (s.t !== 'trait') return
    let m = traitMethods.get(s.n)
    if (!m) { m = new Map(); traitMethods.set(s.n, m) }
    syms.forEach((x, j) => { if (isM(x) && inSpan(s, x) && !m.has(x.n)) m.set(x.n, j) })
  })
  const t = new Map() // trait 方法 idx → Set(impl 方法 idx)
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
