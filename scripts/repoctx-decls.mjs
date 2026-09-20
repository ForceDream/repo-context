/**
 * 声明层（declaration layer）——**声明形态的单一事实源 + 缺口登记处**（2026-09-16）
 *
 * 问题：抽取器"漏了什么"一直靠人肉发现。本轮就是例子——一次全量测试才看出
 * `const { a, b } = obj`（解构）与类型标注（`x: Foo`）根本没进索引，而"类型引用"这类缺失
 * 属于**没人去找就永远发现不了**的空白。
 *
 * 解法：把"这门语言里有哪些声明形态 / 我们抽不抽 / 为什么不抽"变成**可枚举、可审计的数据**，
 * 再用一次真实源码**普查**（census）把登记表之外的形态揪出来——漏掉的东西自己冒出来。
 *
 * 三层信息：
 *   `LANG_DECLS`  —— 抽取器实际使用的 节点类型 → kind 映射（**唯一事实源**，抽取器 import 它）。
 *   `DECL_FORMS`  —— 声明形态登记表，每条带 status（**四种**，四十九轮定型）：
 *                      `extracted` 已抽成符号（必须在 LANG_DECLS 里，测试会查漂移）
 *                      `covered`   **非符号形态，已被某个机制消费**（附 why 说明是哪个机制）——
 *                                  如 `type_annotation` 的类型名经 `trefs` 进类型边族、`import_specifier` 进导入绑定
 *                      `planned`   **已识别、待补**（附动机）——这就是补齐清单
 *                      `skipped`   明确不抽（附理由，避免重复讨论/被"修复"回来）
 *   `isDeclLike`  —— 判断"这个节点类型像不像声明"，census 的筛子（宁宽勿窄：漏筛会漏发现）。
 *
 * 缺口发现（登记表 ↔ 实际节点类型出现次数比对）：
 *   每个语言统计节点类型出现次数 → 与登记表比对：
 *     · `extracted` 且出现      → 正常
 *     · `planned`  且出现      → 待补清单（有量级，可排优先级）
 *     · `unnamed`  出现了未登记 → **新发现**，看完样例决定归到 extracted / planned / skipped
 *     · `planned/skipped` 但零出现 → 登记过期（语法版本变了或判断错了），也值得看一眼
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 抽取器实际使用的节点类型 → kind。**唯一事实源**：repoctx-ast.mjs 直接 import 本表。 */
export const LANG_DECLS = {
  rust: [
    ['function_item', 'fn'], ['struct_item', 'struct'], ['enum_item', 'enum'],
    ['trait_item', 'trait'], ['mod_item', 'mod'], ['const_item', 'const'],
    ['static_item', 'const'], ['macro_definition', 'macro'], ['type_item', 'type'],
    ['impl_item', 'impl'],
    // trait 方法声明（无函数体，如 `async fn call(&self, ...);`）——它是动态派发的"源头符号"，
    // 没有它 trait→impl 派发表就断了源头（实测 28 个 XxxTool::call 的 impl 因此找不到归属）。
    ['function_signature_item', 'fn'],
    // ── 2026-09-16 第四十九轮：声明层补齐（字段/变体/泛型参数）──────────────────
    ['field_declaration', 'field'],   // `pub retries: u32`（实测全仓 1,209 处）
    ['enum_variant', 'variant'],      // `Red,`（71 处）
    // 注：**rust 没有 `type_parameter` 节点**——纯泛型参数直接是 `type_parameters` 下的 `type_identifier`
    // （实测树形），所以不登记为符号；带约束的才是 `constrained_type_parameter` ✓
    ['constrained_type_parameter', 'type'], // `<T: Trait>`（8 处；抽出即 local）
    ['type_binding', 'type'],         // 关联类型绑定 `Output = ()`（2 处）
  ],
  ts: [
    ['function_declaration', 'fn'], ['generator_function_declaration', 'fn'],
    ['class_declaration', 'class'], ['abstract_class_declaration', 'class'],
    ['interface_declaration', 'iface'], ['type_alias_declaration', 'type'],
    ['enum_declaration', 'type'], ['method_definition', 'method'],
    ['lexical_declaration', 'var'], ['variable_declaration', 'var'],
    // ── 2026-09-16 第四十九轮：声明层补齐（类字段/接口成员/泛型参数）────────────
    ['public_field_definition', 'field'], // 类字段（3 处）
    ['property_signature', 'prop'],       // 接口属性成员 `retries: number`（1,693 处）
    ['type_parameter', 'type'],           // `<T extends X>`（4 处）
  ],
  js: [
    ['function_declaration', 'fn'], ['generator_function_declaration', 'fn'],
    ['class_declaration', 'class'], ['method_definition', 'method'],
    ['lexical_declaration', 'var'], ['variable_declaration', 'var'],
    ['public_field_definition', 'field'], // ES2022 class fields（本仓 0 处，登记待用：真出现即可抽）
  ],
  py: [
    ['function_definition', 'fn'], ['class_definition', 'class'],
  ],
}

/** 抽取器可能产出的 kind 全集（新增 kind 必须同步这里与文档） */
export const KIND_UNIVERSE = new Set(['fn', 'method', 'class', 'iface', 'struct', 'enum', 'trait', 'type', 'mod', 'var', 'const', 'macro', 'impl', 'field', 'variant', 'prop', 'sec'])

/**
 * 声明形态登记表。node = tree-sitter 节点类型；kind 仅 extracted 需要。
 * `why` 是给**未来的自己**看的：planned 写"为什么值得补"，skipped 写"为什么不补"。
 */
export const DECL_FORMS = {
  rust: [
    // ── 已抽（符号形态）──（field_declaration / enum_variant / 泛型参数已于第四十九轮补入 LANG_DECLS）
    ...[...LANG_DECLS.rust].map(([node, kind]) => ({ node, kind, status: 'extracted' })),
    // ── 已覆盖（非符号形态，被某个机制消费）──
    { node: 'use_declaration', status: 'covered', why: '导入绑定：经 AST 提取进 `imports.names`/`imports.aliases`（含别名），供"谁导入了这个符号"与别名兜底使用；实测 636 次' },
    { node: 'type_identifier', status: 'covered', why: '**类型引用**：经 `trefs` 进入**类型边族**（`map.typeEdges`，`typerefs` 动词查询）。**不进调用图**——类型引用不是调用，混进 callers 会毁精度；实测全仓 5357 次，是最大的一块' },
    // ── 明确不抽 ──
    { node: 'let_declaration', status: 'skipped', why: '函数内局部变量——局部引用的边无价值（第三十一轮实测），已作为局部名从 refs 排除' },
    { node: 'parameter', status: 'skipped', why: '形参——同上，作为局部名处理' },
    { node: 'self_parameter', status: 'skipped', why: '`&self`/`&mut self`——形参的一种；实测本仓 232 次' },
    { node: 'attribute_item', status: 'skipped', why: '属性（`#[test]`/`#[derive]`）——不是调用图节点；实测 789 次。若将来做"测试用例清单"再单独取' },
    { node: 'type_parameter', status: 'skipped', why: '**rust 语法里没有这个节点**（实测树形：纯泛型参数直接是 `type_parameters` 下的 `type_identifier`）。它的**约束**已由 constrained_type_parameter 抽取、其**类型位引用**经 trefs 进类型边族' },
  ],
  ts: [
    // ── 已抽（符号形态）──（类字段/接口成员/泛型参数已于第四十九轮补入 LANG_DECLS）
    ...[...LANG_DECLS.ts].map(([node, kind]) => ({ node, kind, status: 'extracted' })),
    // ── 已覆盖（非符号形态，被某个机制消费）──
    { node: 'type_annotation', status: 'covered', why: '变量/参数/返回类型标注：其**类型名**（type_identifier）经 `trefs` 进入类型边族；标注节点本身不产符号（它没有名字）。实测 2790 次（ts 1722 + tsx 1068）' },
    { node: 'opting_type_annotation', status: 'covered', why: '可选参数类型标注（`?: T`）——同上，经 trefs 覆盖；实测 1 次' },
    { node: 'type_predicate_annotation', status: 'covered', why: '类型谓词（`v is number`）——同上，经 trefs 覆盖；实测 1 次' },
    { node: 'type_identifier', status: 'covered', why: '**类型引用**：经 `trefs` 进入**类型边族**（`map.typeEdges`，`typerefs` 查询）。**不进调用图**——类型引用不是调用；实测 1276 次（ts 720 + tsx 556）' },
    { node: 'import_statement', status: 'covered', why: '导入声明：经 AST 提取进 `imports.names`/`aliases`；实测 511 次（ts 73 + tsx 348 + js 90）' },
    { node: 'import_clause', status: 'covered', why: '导入子句（default / `{ … }` 段）——被上面的导入绑定提取消费；实测 508 次' },
    { node: 'import_specifier', status: 'covered', why: '具体导入名（`import { Foo as Bar }`）——导入绑定与别名的来源；实测 896 次' },
    // ── 明确不抽 ──
    { node: 'index_signature', status: 'skipped', why: '索引签名（`[key: string]: unknown`）——**没有简单名**，不是可引用目标；实测 6 次（其类型部分仍经 trefs 记入类型边）' },
    { node: 'call_signature', status: 'skipped', why: '可调用成员签名（接口里的 `(x): T`）——没有名字；实测 1 次' },
    { node: 'ambient_declaration', status: 'skipped', why: '环境声明（`.d.ts` 的 `declare module "x"`）——**本身不产符号**，它内部的声明由普通规则照常抽出（descendantsOfType 穿透）；实测 3 次' },
    { node: 'variable_declarator', status: 'skipped', why: '声明名容器——多 declarator 只取首个、解构不产符号（实测：解构 228 处**全在函数内**→ 不产符号无损失；多 declarator 仅 6 处）' },
    { node: 'required_parameter', status: 'skipped', why: '形参——局部名' },
    { node: 'optional_parameter', status: 'skipped', why: '形参——局部名' },
    { node: 'object_pattern', status: 'skipped', why: '解构模式——局部名' },
    { node: 'array_pattern', status: 'skipped', why: '解构模式——局部名' },
  ],
  js: [
    ...[...LANG_DECLS.js].map(([node, kind]) => ({ node, kind, status: 'extracted' })),
    { node: 'import_statement', status: 'covered', why: '导入声明：经 AST 提取进 `imports.names`/`aliases`；实测 90 次' },
    { node: 'import_clause', status: 'covered', why: '导入子句——被导入绑定提取消费；实测 90 次' },
    { node: 'import_specifier', status: 'covered', why: '具体导入名——导入绑定与别名来源；实测 62 次' },
    { node: 'variable_declarator', status: 'skipped', why: '声明名容器——同 ts' },
    { node: 'object_pattern', status: 'skipped', why: '解构模式——局部名' },
    { node: 'array_pattern', status: 'skipped', why: '解构模式——局部名' },
    // 注：`required_parameter`/`optional_parameter` 在本仓 js 下**零出现**（JS 形参不带 required/optional 标记）
    // → 不登记。真出现时会被 census 当作"未归类"报出来（筛子按 `_parameter` 后缀命中），自愈。
  ],
  py: [
    ...[...LANG_DECLS.py].map(([node, kind]) => ({ node, kind, status: 'extracted' })),
    { node: 'assignment', status: 'skipped', why: '赋值——Python 无声明语法，赋值即定义；本仓库无 Python 源码，暂不深究' },
  ],
}

/** 语言别名 → 登记表键（tsx 走 ts，jsx 走 js） */
export const formsLangKey = (lang) => (lang === 'tsx' ? 'ts' : lang === 'jsx' ? 'js' : lang)

/** 取某语言的登记表（Map：node → form） */
export function formsOf(lang) {
  const m = new Map()
  for (const f of DECL_FORMS[formsLangKey(lang)] || []) m.set(f.node, f)
  return m
}

/**
 * "这个节点类型像不像声明"——census 的筛子。**宁宽勿窄**：漏筛会漏发现（这是本层存在的理由），
 * 误筛只是多一条待归类，代价低。
 *
 * 判定用**末段后缀**（不是任意段的包含）——首跑实践教训：按"任意段命中"匹配时，
 * `property_identifier`（12.8 万次）、`member_expression`（5.4 万次）、`else_clause` 这类
 * **非声明**节点会霸占榜单，把真正的缺口（`type_annotation` 等）挤下去。末段匹配一次就清净了。
 */
const DECL_SUFFIX = new Set([
  'declaration', 'declarator', 'definition', 'item', 'signature', 'annotation',
  'variant', 'field', 'parameter', 'binding',
])
/** 少数形态不带上述后缀但确实是声明/绑定层面的东西，显式列出 */
const DECL_EXTRA = new Set(['type_identifier', 'import_clause', 'import_specifier', 'object_pattern', 'array_pattern'])
export const isDeclLike = (type) => {
  if (DECL_EXTRA.has(type)) return true
  const segs = type.split('_')
  return DECL_SUFFIX.has(segs[segs.length - 1])
}

/**
 * 与登记表比对一批计数。counts 可为 Map 或 [[type, count]]。
 * 返回 { extracted, planned, skipped, unclassified }（各自按 count 降序）。
 */
export function classifyCounts(lang, counts) {
  const forms = formsOf(lang)
  const out = { extracted: [], covered: [], planned: [], skipped: [], unclassified: [] }
  for (const [node, count] of counts instanceof Map ? counts : counts) {
    if (!count) continue
    const f = forms.get(node)
    if (f) out[f.status].push({ node, count, kind: f.kind, why: f.why })
    else if (isDeclLike(node)) out.unclassified.push({ node, count })
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.count - a.count)
  return out
}

/**
 * 登记表自检：返回问题列表（空 = 一致）。测试与 `--self-check` 都用它。
 * 检查项：① extracted ⟺ LANG_DECLS 完全对应（双向）；② kind 在 KIND_UNIVERSE 内；③ planned/skipped 必须写 why。
 */
export function selfCheck() {
  const problems = []
  for (const lang of Object.keys(LANG_DECLS)) {
    const decls = new Set(LANG_DECLS[lang].map(([node]) => node))
    const forms = new Map(DECL_FORMS[lang].map((f) => [f.node, f]))
    for (const [node, kind] of LANG_DECLS[lang]) {
      const f = forms.get(node)
      if (!f) problems.push(`${lang}: LANG_DECLS 有 ${node} 但登记表缺`)
      else if (f.status !== 'extracted') problems.push(`${lang}: ${node} 在 LANG_DECLS 里但登记为 ${f.status}`)
      if (!KIND_UNIVERSE.has(kind)) problems.push(`${lang}: ${node} 的 kind=${kind} 不在 KIND_UNIVERSE`)
    }
    for (const f of DECL_FORMS[lang]) {
      if (f.status === 'extracted' && !decls.has(f.node)) problems.push(`${lang}: 登记为 extracted 的 ${f.node} 不在 LANG_DECLS 里（漂移）`)
      if (f.status !== 'extracted' && !f.why) problems.push(`${lang}: ${f.node}（${f.status}）必须写 why`)
      if (f.status === 'extracted' && f.kind !== forms.get(f.node)?.kind) {
        const k = LANG_DECLS[lang].find(([n]) => n === f.node)?.[1]
        if (k && f.kind !== k) problems.push(`${lang}: ${f.node} 的 kind 登记为 ${f.kind}，LANG_DECLS 里是 ${k}`)
      }
    }
  }
  return problems
}

/** 汇总多文件的计数（Map<node,count> 列表） */
export function sumCounts(list) {
  const total = new Map()
  for (const m of list) for (const [t, c] of m) total.set(t, (total.get(t) || 0) + c)
  return total
}

/** 合并多语言的分类结果（用于全仓报告） */
export function mergeClassified(perLang) {
  const out = {}
  for (const [lang, cls] of Object.entries(perLang)) {
    for (const bucket of ['extracted', 'covered', 'planned', 'skipped', 'unclassified']) {
      for (const item of cls[bucket]) {
        const key = `${bucket}:${item.node}`
        const cur = out[key] || (out[key] = { lang, bucket, node: item.node, count: 0, kind: item.kind, why: item.why })
        cur.count += item.count
      }
    }
  }
  return Object.values(out).sort((a, b) => b.count - a.count)
}

/** 读一个文件里的（可选）登记表补充：仓库可在 `.repoctx/decls.json` 追加本地形态（团队自治） */
export function loadLocalForms(repo) {
  try {
    const p = path.join(repo, '.repoctx', 'decls.json')
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return null }
}
