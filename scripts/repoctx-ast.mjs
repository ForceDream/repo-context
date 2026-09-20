/**
 * repoctx-ast —— 真实 AST 抽取（tree-sitter WASM），**可选增强**
 *
 * 为什么需要它：行级正则抽取的两个主要噪声源正好是 AST 天然能消掉的：
 *   1. **注释与字符串里的标识符**被当成了引用（正则无法区分，AST 里它们根本不是 identifier 节点）；
 *   2. **局部变量**（参数、let/const）与外部同名符号混在一起（AST 能取到声明位置，可以排除）。
 * 精度提升的代价是一次性 `npm install web-tree-sitter tree-sitter-wasms`（约 54MB，语法文件 6MB）。
 *
 * 设计约定：**它是增强而非依赖**。未安装 / 语法缺失 / 解析失败 → 返回 null，调用方自动落回行级抽取。
 * 这样"任何装了 Node 的机器上零安装可用"这条底线不会被破坏。
 */

// DECLS 现在住在**声明层**模块（单一事实源）：那里同时维护"哪些形态抽 / 待补 / 不抽 + 理由"。
// 此处只消费节点→kind 映射。
import { LANG_DECLS as DECLS, isDeclLike } from './repoctx-decls.mjs'

/** 每种语言里"算作一个决策点"的节点类型（近似圈复杂度 = 1 + 决策数） */
const BRANCH_NODES = {
  rust: ['if_expression', 'match_arm', 'while_expression', 'loop_expression', 'for_expression', 'try_expression'],
  ts: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_case', 'catch_clause', 'conditional_expression'],
  js: ['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
    'switch_case', 'catch_clause', 'conditional_expression'],
  py: ['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'except_clause',
    'conditional_expression', 'case_clause'],
}
/** 逻辑运算符也算决策（&& / || / and / or） */
const BRANCH_OPS = new Set(['&&', '||', 'and', 'or', '??'])

/** 声明局部名字的节点：出现在里面的 identifier 一律视为"局部"，不作为跨符号引用 */
const LOCAL_DECL_NODES = [
  'formal_parameters', 'parameters', 'required_parameter', 'optional_parameter',
  'typed_parameter', 'default_parameter', 'rest_pattern', 'variable_declarator',
  'let_declaration', 'assignment_pattern', 'shorthand_property_identifier_pattern',
]
const IDENT_NODES = ['identifier', 'property_identifier', 'type_identifier', 'field_identifier']

export async function createAstExtractor({ wasmDir }) {
  const fs = await import('node:fs')
  const path = await import('node:path')

  // 版本兼容：0.25+ 是 ESM 命名导出（Parser/Language）；0.20.x 是 CJS 默认导出 + Parser.Language。
  // 实测 **0.27 与 tree-sitter-wasms@0.1.13（ABI 14）不兼容**：Language.load 抛**空消息**异常，
  // 极难排查 —— 故这里两种 API 都支持，并把 ABI 不匹配如实写进 reason（不写成笼统的"未安装"）。
  let mod
  let Parser
  try {
    mod = await import('web-tree-sitter')
    Parser = mod.Parser || mod.default
    if (!Parser?.init) throw new Error('exports 中没有 Parser')
  } catch (e) {
    return { available: false, reason: `web-tree-sitter 加载失败：${e.message}` }
  }

  await Parser.init()
  // ⚠️ Language 必须**在 init 之后**取：0.20.x 的 `Parser.Language` 是 init 期间才挂到构造函数上的，
  // 提前读会得到 undefined（实测报"exports 中没有 Language.load"，误导排查方向）。
  const Language = mod.Language || Parser.Language
  if (!Language?.load) {
    return { available: false, reason: 'web-tree-sitter 未暴露 Language.load（runtime 与语法 ABI 版本可能不匹配）' }
  }
  const parser = new Parser()

  const FILE = {
    rust: 'tree-sitter-rust.wasm', ts: 'tree-sitter-typescript.wasm', tsx: 'tree-sitter-tsx.wasm',
    js: 'tree-sitter-javascript.wasm', jsx: 'tree-sitter-javascript.wasm', py: 'tree-sitter-python.wasm',
  }
  const langs = {}
  const missing = []
  for (const [key, file] of Object.entries(FILE)) {
    const p = path.join(wasmDir, file)
    if (!fs.existsSync(p)) { missing.push(`${file}(缺文件)`); continue }
    try { langs[key] = await Language.load(p) } catch (e) {
      missing.push(`${file}(ABI/版本不匹配：${e.message || '空消息——语法 ABI 与 runtime 不符'})`)
    }
  }
  if (!Object.keys(langs).length) return { available: false, reason: `语法文件不可用：${missing.join(', ')}` }

  const MAX_PARSE_BYTES = 1024 * 1024

  /** 只接受"简单标识符"作为符号名：解构声明的 name 是对象模式（`{ audit: dispatch, rulesets }`），
   *  直接拿来当符号名会污染检索结果（实测在 --for 输出里出现过这种"符号"）。 */
  const SIMPLE_NAME = /^[A-Za-z_$][\w$]*$/
  /**
   * 抽出即为"**容器内局部名**"的声明节点（泛型参数、关联类型绑定）。
   * 它们的 kind 仍是 `type`（它们确实是类型名，类型边解析要能把 `T` 指向它的声明），
   * 但**不该进枢纽/API 面**——`T`/`U`/`K` 在仓库里必然撞名，混进 API 排序只会制造噪声。
   */
  const LOCAL_DECL_TYPES = new Set(['type_parameter', 'constrained_type_parameter', 'type_binding'])

  function nameOf(node, kind) {
    const direct = node.childForFieldName?.('name')
    if (direct && SIMPLE_NAME.test(direct.text)) return direct.text
    if (kind === 'impl') {
      const t = node.childForFieldName?.('type')
      if (t) {
        const n = t.text.replace(/<.*$/, '')
        if (SIMPLE_NAME.test(n)) return n
      }
    }
    if (kind === 'var' || kind === 'const') {
      const d = (node.descendantsOfType?.('variable_declarator') || [])[0]
      const n = d?.childForFieldName?.('name')
      if (n && SIMPLE_NAME.test(n.text)) return n.text
    }
    if (LOCAL_DECL_TYPES.has(node.type)) {
      // 泛型参数/关联类型绑定的字段名各语言不一致（rust 的 constrained_type_parameter 用
      // `left`/`bounds`，不是 `name`；type_binding 用 `name`）→ 逐个试 + 兜底取首个标识符
      for (const f of ['name', 'left']) {
        const x = node.childForFieldName?.(f)
        if (x && SIMPLE_NAME.test(x.text)) return x.text
      }
      const id = (node.descendantsOfType?.(['type_identifier', 'identifier']) || [])[0]
      if (id && SIMPLE_NAME.test(id.text)) return id.text
    }
    return null
  }

  function cyclomatic(symNode, lang) {
    let decisions = 0
    for (const t of (BRANCH_NODES[lang] || [])) decisions += (symNode.descendantsOfType?.(t) || []).length
    for (const b of (symNode.descendantsOfType?.('binary_expression') || [])) {
      const op = b.childForFieldName?.('operator')?.text
      if (op && BRANCH_OPS.has(op)) decisions++
    }
    return decisions + 1
  }

  /**
   * 局部名字的语义（**唯一实现见 extract 内的内联收集**，2026-09-15 性能优化时合并）：
   * 只取**声明侧的绑定名**（参数名、解构模式名、变量声明名），
   * **不取 `type_identifier`**——参数类型是类型引用（trefs），不是局部名。
   *
   * ⚠️ 两个踩过的坑：① 最初把 `variable_declarator` **整个子树**的标识符都算局部，于是
   * `const ruleRun = runRules(...)` 里的 `runRules` 被当局部变量排除，`callers runRules` 变成 0；
   * ② 2026-09-16：参数列表用 IDENT_NODES 横扫，把参数**类型名**也当局部名，导致类型边族漏掉
   * 参数类型这一类最常见的类型引用。（原独立函数 localNames 已删除：内联版才是生效实现，留着是陷阱。）
   */

  /** 返回与行级抽取同形的符号数组（多带 endLine / cx / refs）；不可用/失败返回 null */
  function extract(relPath, lang, text) {
    const language = langs[lang]
    if (!language) return null
    if (text.length > MAX_PARSE_BYTES) return null
    parser.setLanguage(language)
    let tree
    try { tree = parser.parse(text) } catch { return null }
    if (!tree) return null

    const out = []
    const root = tree.rootNode
    /** 能作为"容器"的节点类型 → 推断其名字时用的 kind（决定 nameOf 走哪条分支） */
    const CONTAINERS = {
      rust: { impl_item: 'impl', trait_item: 'trait', struct_item: 'struct', enum_item: 'enum', mod_item: 'mod', function_item: 'fn' },
      ts: {
        class_declaration: 'class', abstract_class_declaration: 'class', interface_declaration: 'iface',
        namespace_declaration: 'mod', module: 'mod', function_declaration: 'fn',
        method_definition: 'method', lexical_declaration: 'var',
      },
      js: { class_declaration: 'class', function_declaration: 'fn', method_definition: 'method', lexical_declaration: 'var' },
      py: { class_definition: 'class', function_definition: 'fn' },
    }
    /**
     * 限定名：容器链自上而下 + 本名，如 `SkillCatalog::is_empty`、`Batch::push`。
     *
     * **只用于展示与解释，不参与任何打分。** 判定层仍是名字匹配（架构不变），
     * `q` 解决的是另一件事：同名候选看不出谁是谁——`amb run` 里两个 `run` 现在能分辨
     * 是 `layout::run` 还是 `repoctx::run`。没有它，人（和 Agent）只能逐个开文件看。
     */
    function qualifiedName(node, name) {
      const cmap = CONTAINERS[lang === 'tsx' ? 'ts' : lang] || {}
      const chain = []
      let p = node.parent
      // guard 防父链异常（含语法错误时 tree-sitter 会产出 ERROR 节点，父链可能异常深）
      for (let guard = 0; p && guard < 40; guard++, p = p.parent) {
        const k = cmap[p.type]
        if (!k) continue
        const n = nameOf(p, k)
        if (n && n !== name) chain.unshift(n)
      }
      return chain.length ? `${chain.join('::')}::${name}` : name
    }

    // ── 一次性收集（性能关键，2026-09-15 第二轮优化）────────────────────────────
    // 原实现是"每个符号各走一遍自己的子树"取 refs / 圈复杂度 / 局部名，而 **impl 与它内部的方法、
    // class 与它的方法，子树互相重叠** → 同一批节点被反复遍历。实测 322 文件 / 5153 符号要 3.6 秒，
    // 其中约 3.46 秒全在抽取（node + WASM 启动只占 0.13 秒）。
    // 改成：整棵树**每类节点各走一遍**（带 startIndex 收集），每个符号用**区间二分**取子集。
    // 单符号成本从 O(子树) 降到 O(log n + k)，且语义等价 —— "在子树内" ≡ "startIndex ∈ [start, end]"。
    /** 局部名的两个来源（与旧 localNames 的实现严格对应，勿混用） */
    const FIELD_DECL_NODES = ['variable_declarator', 'let_declaration', 'required_parameter',
      'optional_parameter', 'typed_parameter', 'default_parameter', 'assignment_pattern']
    const PARAM_LIST_NODES = ['formal_parameters', 'parameters']

    // 关键：**整棵树只遍历一次**。若沿用 descendantsOfType 分别取"标识符 / 每个决策节点类型 /
    // 二元表达式 / 每个局部声明类型 / 参数列表"，累计是 **10+ 次全树遍历**（每次都要走遍所有节点，
    // JS 侧的递归开销很实在）。改成把这些类型合成一个集合**一次取回**，再在 JS 里按 type 分桶。
    const WANTED_TYPES = [...new Set([
      ...IDENT_NODES, ...(BRANCH_NODES[lang] || []), 'binary_expression',
      ...FIELD_DECL_NODES, ...PARAM_LIST_NODES,
      // 导入声明（AST 版导入绑定：别名 + 本文件导入的原始名清单，取代正则 aliasScan 的退化形态）
      'import_statement', 'use_declaration',
    ])]
    const identSet = new Set(IDENT_NODES)
    const branchSet = new Set(BRANCH_NODES[lang] || [])
    const fieldSet = new Set(FIELD_DECL_NODES)
    const paramSet = new Set(PARAM_LIST_NODES)

    const identNodes = []
    const cxMarks = []
    const fieldDecls = []
    const paramLists = []
    const importNodes = []
    for (const n of (root.descendantsOfType?.(WANTED_TYPES) || [])) {
      const t = n.type
      // identNodes 记下**节点类型**：同一个节点集合要服务两个用途——
      // 值引用（refs，**排除 type_identifier**，见下方注释）与类型引用（trefs）。
      if (identSet.has(t)) identNodes.push({ s: n.startIndex, t: n.text, ty: t })
      // 圈复杂度标记：决策节点 + 带逻辑运算符的二元表达式（各记 1 个决策）
      if (branchSet.has(t)) cxMarks.push({ s: n.startIndex })
      if (t === 'binary_expression' && BRANCH_OPS.has(n.childForFieldName?.('operator')?.text)) cxMarks.push({ s: n.startIndex })
      if (fieldSet.has(t)) fieldDecls.push({ s: n.startIndex, n })
      if (paramSet.has(t)) paramLists.push({ s: n.startIndex, n })
      if (t === 'import_statement' || t === 'use_declaration') importNodes.push(n)
    }
    for (const arr of [identNodes, cxMarks, fieldDecls, paramLists]) arr.sort((a, b) => a.s - b.s)

    // ── scoped 调用的限定上下文（Rust `Foo::bar(x)`）──────────────────────────
    // 调用点**自己写明了作用域路径**——这是纯名字级的消解事实（非统计、非推断、非类型系统），
    // 2026-09-16 第三十六轮实测：歧义名 UFCS 站点 1011 个，其中 140 个可由"显式路径 × 候选 q 前缀"
    // 唯一解析（四轮消歧测量里唯一幸存的确定性信号）。此前 buildEdges 把 `Foo::bar` 拆成裸 token，
    // 限定上下文丢失 → `bar` 落进歧义桶。只在 rust 收集（其它语言没有 :: 路径调用形态）。
    const scopedCalls = []
    if (lang === 'rust') {
      for (const c of (root.descendantsOfType?.('call_expression') || [])) {
        const fn = c.childForFieldName?.('function')
        if (!fn || fn.type !== 'scoped_identifier') continue
        const segs = fn.text.split('::')
        if (segs.length < 2) continue
        const nm = segs[segs.length - 1]
        if (!SIMPLE_NAME.test(nm)) continue
        // 限定符 = 除末段外的完整路径；crate/self/super 前缀由匹配侧归一
        scopedCalls.push({ s: fn.startIndex, path: segs.slice(0, -1).join('::'), name: nm })
      }
      scopedCalls.sort((a, b) => a.s - b.s)
    }

    /**
     * 导入绑定（**AST 版**，2026-09-16）：取代正则 aliasScan 的退化形态。
     *   aliases：local → original（`use a::b::Foo as Bar` / `import { Foo as Bar }`）
     *   names  ：本文件导入的**原始名**清单——正则版本拿不到这个（无别名的 `import { Foo }` 它根本不记），
     *            它是"谁导入了这个符号"（依赖面）的唯一数据源，也是 import 图的基础。
     *
     * 只用**源码显式声明**（确定性）；glob（`use x::*` / `import * as ns`）跳过——没有简单原始名。
     * 结果挂回 dedup 数组（`dedup.imports`），**不改 extract 的返回类型**（调用方零改动）。
     */
    const importAliases = new Map()
    const importNames = new Set()
    const SKIP_PATH_SEG = new Set(['self', 'crate', 'super', 'std', 'core', 'alloc'])
    const addBinding = (orig, local) => {
      const o = orig && SIMPLE_NAME.test(orig) ? orig : null
      const l = local && SIMPLE_NAME.test(local) ? local : null
      if (o && !SKIP_PATH_SEG.has(o)) importNames.add(o)
      if (o && l && l !== o) importAliases.set(l, o)
    }
    const lastSeg = (p) => p.text.split('::').pop()
    /** rust：`use` 树只取**叶子绑定点**（不能盲目横扫子树内 identifier——路径前缀 a/b 会被误当导入名） */
    const rustUseArg = (arg) => {
      if (!arg) return
      switch (arg.type) {
        case 'identifier': case 'type_identifier': addBinding(arg.text, arg.text); break
        case 'use_as_clause': {
          const p = arg.childForFieldName?.('path'); const al = arg.childForFieldName?.('alias')
          if (p && al) addBinding(lastSeg(p), al.text)
          break
        }
        case 'scoped_identifier': addBinding(lastSeg(arg), lastSeg(arg)); break
        case 'scoped_use_list': {
          const list = arg.childForFieldName?.('list')
          for (const c of (list?.namedChildren || [])) rustUseArg(c)
          break
        }
        case 'use_list': for (const c of arg.namedChildren || []) rustUseArg(c); break
        default: break // use_wildcard 等：无简单原始名，跳过
      }
    }
    for (const st of importNodes) {
      if (st.type === 'use_declaration') {
        rustUseArg(st.childForFieldName?.('argument'))
        continue
      }
      const clause = (st.namedChildren || []).find((c) => c.type === 'import_clause')
      if (!clause) continue
      for (const c of clause.namedChildren || []) {
        if (c.type === 'identifier') addBinding(c.text, c.text)          // default import
        else if (c.type === 'named_imports') {
          for (const sp of c.namedChildren || []) {
            if (sp.type !== 'import_specifier') continue
            const nm = sp.childForFieldName?.('name')?.text
            const al = sp.childForFieldName?.('alias')?.text
            addBinding(nm, al || nm)
          }
        }
        // namespace_import（`* as ns`）：无简单原始名，跳过
      }
    }

    const lowerBound = (arr, x) => { let l = 0, r = arr.length; while (l < r) { const m = (l + r) >> 1; if (arr[m].s < x) l = m + 1; else r = m } return l }
    const upperBound = (arr, x) => { let l = 0, r = arr.length; while (l < r) { const m = (l + r) >> 1; if (arr[m].s <= x) l = m + 1; else r = m } return l }

    // 用各语言的声明节点类型抓取，按起始位置排序（保证确定性）
    for (const [type, kind] of DECLS[lang === 'tsx' ? 'ts' : lang] || DECLS[lang] || []) {
      for (const node of (root.descendantsOfType?.(type) || [])) {
        const name = nameOf(node, kind)
        // 单字符名过滤（噪声）：**泛型参数例外**——`T`/`U`/`K` 天生单字符，且它们是容器内局部名
        // （local=true，不进枢纽），放行不会污染任何排序。
        const isLocalDecl = LOCAL_DECL_TYPES.has(node.type)
        if (!name || (name.length < 2 && !isLocalDecl)) continue
        const a = node.startIndex
        const b = node.endIndex

        // 局部名：① 声明节点的 name/pattern 字段 ② 参数列表整棵子树（只含参数声明，不含函数体）
        const locals = new Set()
        for (let k = lowerBound(fieldDecls, a), e = upperBound(fieldDecls, b); k < e; k++) {
          for (const f of ['name', 'pattern']) {
            const fld = fieldDecls[k].n.childForFieldName?.(f)
            if (!fld) continue
            if (fld.type === 'identifier' || fld.type === 'shorthand_property_identifier_pattern') { locals.add(fld.text); continue }
            for (const id of (fld.descendantsOfType?.(IDENT_NODES) || [])) locals.add(id.text)
          }
        }
        // 参数列表：**只取绑定名**（identifier / 解构模式），不取 `type_identifier`——
        // 参数类型是**类型引用**（trefs 的数据源）而不是局部名。
        // 实测教训（2026-09-16）：原实现用 IDENT_NODES 横扫参数列表，于是 `fn load(cfg: &Cfg)` 里的
        // `Cfg` 被当成局部名排除，**参数类型永远进不了类型边族**（漏掉最常见的一类类型引用）。
        const BINDING_NODES = ['identifier', 'shorthand_property_identifier_pattern']
        for (let k = lowerBound(paramLists, a), e = upperBound(paramLists, b); k < e; k++) {
          for (const id of (paramLists[k].n.descendantsOfType?.(BINDING_NODES) || [])) locals.add(id.text)
        }

        // 引用分两族（2026-09-16 拆族）：
        //   refs  值引用（调用/使用）——**排除 type_identifier**；
        //   trefs 类型引用（类型位上的类型名）——独立成"类型边"族
        // 拆族前 type_identifier 混在 refs 里，于是 `pub cfg: Config` 会在调用图里连出 Cfg→Config
        // 这条**并不存在的"调用"边**，直接污染 callers/impact 的精度（信息没丢：类型引用现在走 trefs）。
        const refs = new Set()
        const trefs = new Set()
        for (let k = lowerBound(identNodes, a), e = upperBound(identNodes, b); k < e; k++) {
          const x = identNodes[k]
          const t = x.t
          if (t === name || locals.has(t)) continue
          if (x.ty === 'type_identifier') { if (t.length >= 2) trefs.add(t); continue }
          if (t.length < 3) continue
          // 只保留"叶子标识符"的文本；同名去重
          refs.add(t)
        }

        // 限定调用（本符号 span 内的 `Foo::bar`）：buildEdges 用"候选 q 前缀"做确定性消解。
        // 与裸 refs 并行携带；buildEdges 消解成功的名字不再走裸名匹配（避免同一调用既计数歧义又连边）。
        const qrefs = []
        const qseen = new Set()
        for (let k = lowerBound(scopedCalls, a), e = upperBound(scopedCalls, b); k < e; k++) {
          const sc = scopedCalls[k]
          if (sc.name === name || sc.name.length < 3) continue
          const key = `${sc.path}::${sc.name}`
          if (qseen.has(key)) continue
          qseen.add(key)
          qrefs.push({ path: sc.path, name: sc.name })
        }

        const q = qualifiedName(node, name)
        // 可见性（R2 可见性消解的数据源）。两个坑（实测踩过，exp 全 false）：
        //   ① Rust 的 `pub` 是 **visibility_modifier 子节点**（不是 childForFieldName('visibility')）；
        //   ② TS 的 `export` 属于 **export_statement 包装节点**，声明节点自身文本里没有它 →
        //      必须看声明**之前**的文本，不能看声明文本前缀。
        // 行级模式不给这个字段（undefined）= 未知，消费侧把"未知"当"可见"，绝不误删边（保守方向）。
        let exp
        if (lang === 'rust') exp = node.children.some((c) => c.type === 'visibility_modifier')
        else if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') exp = /(^|\s)export\s*$/.test(text.slice(Math.max(0, a - 24), a))

        // impl 块的 trait 名（`impl Trait for Type` 的 Trait 段）——trait→impl 派发表的数据源。
        // 固有 impl（无 trait）→ undefined；带泛型/路径的取末段简单名，非简单名（如 dyn/引用）→ undefined。
        let tr
        if (kind === 'impl') {
          const tn = node.childForFieldName?.('trait')
          if (tn) {
            const n = tn.text.replace(/<.*$/, '').split('::').pop()
            if (SIMPLE_NAME.test(n)) tr = n
          }
        }
        out.push({
          name,
          kind,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          ind: node.startPosition.column,
          cx: upperBound(cxMarks, b) - lowerBound(cxMarks, a) + 1,
          sig: text.slice(a, a + 200).split('\n')[0].trim(),
          q: q === name ? undefined : q, // 无容器时省略（仅省产物体积，语义不变）
          tr,                            // 仅 impl 有值；其余 kind 省略（undefined 不序列化）
          qrefs: qrefs.length ? qrefs : undefined, // 仅 rust scoped 调用；落盘时由 serializable 裁掉
          exp,                           // 可见性（rust pub / TS export）；undefined = 未知（消费侧保守处理）
          local: LOCAL_DECL_TYPES.has(node.type) ? true : undefined, // 泛型参数/关联类型：容器内局部名（不进枢纽）
          refs: [...refs],
          trefs: trefs.size ? [...trefs].sort() : undefined, // 类型引用（类型边族数据源）；落盘时裁掉
        })
      }
    }
    // 同一行可能被多个规则命中（如 impl + method），按 (line, name) 去重
    const seen = new Set()
    const dedup = out.filter((s) => {
      const key = `${s.line}|${s.name}|${s.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    dedup.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
    // 导入绑定挂回返回数组（属性，不是元素）——**不改返回类型**：调用方仍在遍历符号，
    // 需要导入信息的（buildIndex）读 `.imports`。AST 不可用/并行模式时没有这个属性 → 调用方退化到正则。
    dedup.imports = { aliases: importAliases, names: [...importNames].sort() }
    tree.delete?.()
    return dedup
  }

  /**
   * 节点类型普查（**声明层缺口发现**用，2026-09-16）：返回 `{ counts, samples }`。
   *   counts : Map(节点类型 → 出现次数)
   *   samples: Map(节点类型 → `文件:行: 片段`)——**只对"像声明"的类型**各留一个样例，
   *            因为审计报告要让人**看着样例归类**（归到 extracted / planned / skipped）。无额外遍历成本。
   *
   * 与 extract 共用同一个 parser（两者都先 setLanguage，顺序调用安全）。
   * 代价：一次完整的 JS 侧树遍历——这是**审计路径**，不在索引热路径上（索引仍旧只走 extract）。
   * 之所以必须"全类型"遍历而不是 `descendantsOfType(清单)`：普查的意义正是找出**清单之外**的形态，
   * 用清单去查等于只看得见已经知道的东西（自我确认）。
   */
  function nodeTypeCensus(relPath, lang, text) {
    const language = langs[lang]
    if (!language) return null
    if (text.length > MAX_PARSE_BYTES) return null
    parser.setLanguage(language)
    let tree
    try { tree = parser.parse(text) } catch { return null }
    if (!tree) return null
    const counts = new Map()
    const samples = new Map()
    const stack = [tree.rootNode]
    while (stack.length) {
      const n = stack.pop()
      // 兼容两种 API 形态（属性 / 方法）——实测本仓装的版本把 hasError 暴露成方法
      const named = typeof n.isNamed === 'function' ? n.isNamed() : n.isNamed !== false
      if (named) {
        counts.set(n.type, (counts.get(n.type) || 0) + 1)
        if (!samples.has(n.type) && isDeclLike(n.type)) {
          samples.set(n.type, `${relPath}:${n.startPosition.row + 1}: ${n.text.slice(0, 72).replace(/\s+/g, ' ')}`)
        }
      }
      const ch = typeof n.children === 'function' ? n.children() : n.children
      if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i])
    }
    tree.delete?.()
    return { counts, samples }
  }

  return { available: true, extract, nodeTypeCensus, langs: Object.keys(langs), missing }
}
