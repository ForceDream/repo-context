


























import { readFileSync } from 'node:fs'
import path from 'node:path'


export const LANG_DECLS = {
  rust: [
    ['function_item', 'fn'], ['struct_item', 'struct'], ['enum_item', 'enum'],
    ['trait_item', 'trait'], ['mod_item', 'mod'], ['const_item', 'const'],
    ['static_item', 'const'], ['macro_definition', 'macro'], ['type_item', 'type'],
    ['impl_item', 'impl'],


    ['function_signature_item', 'fn'],

    ['field_declaration', 'field'],
    ['enum_variant', 'variant'],


    ['constrained_type_parameter', 'type'],
    ['type_binding', 'type'],
  ],
  ts: [
    ['function_declaration', 'fn'], ['generator_function_declaration', 'fn'],
    ['class_declaration', 'class'], ['abstract_class_declaration', 'class'],
    ['interface_declaration', 'iface'], ['type_alias_declaration', 'type'],
    ['enum_declaration', 'type'], ['method_definition', 'method'],
    ['lexical_declaration', 'var'], ['variable_declaration', 'var'],

    ['public_field_definition', 'field'],
    ['property_signature', 'prop'],
    ['type_parameter', 'type'],
  ],
  js: [
    ['function_declaration', 'fn'], ['generator_function_declaration', 'fn'],
    ['class_declaration', 'class'], ['method_definition', 'method'],
    ['lexical_declaration', 'var'], ['variable_declaration', 'var'],
    ['public_field_definition', 'field'],
  ],
  py: [
    ['function_definition', 'fn'], ['class_definition', 'class'],
  ],
}


export const KIND_UNIVERSE = new Set(['fn', 'method', 'class', 'iface', 'struct', 'enum', 'trait', 'type', 'mod', 'var', 'const', 'macro', 'impl', 'field', 'variant', 'prop', 'sec'])





export const DECL_FORMS = {
  rust: [

    ...[...LANG_DECLS.rust].map(([node, kind]) => ({ node, kind, status: 'extracted' })),

    { node: 'use_declaration', status: 'covered', why: '导入绑定：经 AST 提取进 `imports.names`/`imports.aliases`（含别名），供"谁导入了这个符号"与别名兜底使用；实测 636 次' },
    { node: 'type_identifier', status: 'covered', why: '**类型引用**：经 `trefs` 进入**类型边族**（`map.typeEdges`，`typerefs` 动词查询）。**不进调用图**——类型引用不是调用，混进 callers 会毁精度；实测全仓 5357 次，是最大的一块' },

    { node: 'let_declaration', status: 'skipped', why: '函数内局部变量——局部引用的边无价值（第三十一轮实测），已作为局部名从 refs 排除' },
    { node: 'parameter', status: 'skipped', why: '形参——同上，作为局部名处理' },
    { node: 'self_parameter', status: 'skipped', why: '`&self`/`&mut self`——形参的一种；实测本仓 232 次' },
    { node: 'attribute_item', status: 'skipped', why: '属性（`#[test]`/`#[derive]`）——不是调用图节点；实测 789 次。若将来做"测试用例清单"再单独取' },
    { node: 'type_parameter', status: 'skipped', why: '**rust 语法里没有这个节点**（实测树形：纯泛型参数直接是 `type_parameters` 下的 `type_identifier`）。它的**约束**已由 constrained_type_parameter 抽取、其**类型位引用**经 trefs 进类型边族' },
  ],
  ts: [

    ...[...LANG_DECLS.ts].map(([node, kind]) => ({ node, kind, status: 'extracted' })),

    { node: 'type_annotation', status: 'covered', why: '变量/参数/返回类型标注：其**类型名**（type_identifier）经 `trefs` 进入类型边族；标注节点本身不产符号（它没有名字）。实测 2790 次（ts 1722 + tsx 1068）' },
    { node: 'opting_type_annotation', status: 'covered', why: '可选参数类型标注（`?: T`）——同上，经 trefs 覆盖；实测 1 次' },
    { node: 'type_predicate_annotation', status: 'covered', why: '类型谓词（`v is number`）——同上，经 trefs 覆盖；实测 1 次' },
    { node: 'type_identifier', status: 'covered', why: '**类型引用**：经 `trefs` 进入**类型边族**（`map.typeEdges`，`typerefs` 查询）。**不进调用图**——类型引用不是调用；实测 1276 次（ts 720 + tsx 556）' },
    { node: 'import_statement', status: 'covered', why: '导入声明：经 AST 提取进 `imports.names`/`aliases`；实测 511 次（ts 73 + tsx 348 + js 90）' },
    { node: 'import_clause', status: 'covered', why: '导入子句（default / `{ … }` 段）——被上面的导入绑定提取消费；实测 508 次' },
    { node: 'import_specifier', status: 'covered', why: '具体导入名（`import { Foo as Bar }`）——导入绑定与别名的来源；实测 896 次' },

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


  ],
  py: [
    ...[...LANG_DECLS.py].map(([node, kind]) => ({ node, kind, status: 'extracted' })),
    { node: 'assignment', status: 'skipped', why: '赋值——Python 无声明语法，赋值即定义；本仓库无 Python 源码，暂不深究' },
  ],
}


export const formsLangKey = (lang) => (lang === 'tsx' ? 'ts' : lang === 'jsx' ? 'js' : lang)


export function formsOf(lang) {
  const m = new Map()
  for (const f of DECL_FORMS[formsLangKey(lang)] || []) m.set(f.node, f)
  return m
}









const DECL_SUFFIX = new Set([
  'declaration', 'declarator', 'definition', 'item', 'signature', 'annotation',
  'variant', 'field', 'parameter', 'binding',
])

const DECL_EXTRA = new Set(['type_identifier', 'import_clause', 'import_specifier', 'object_pattern', 'array_pattern'])
export const isDeclLike = (type) => {
  if (DECL_EXTRA.has(type)) return true
  const segs = type.split('_')
  return DECL_SUFFIX.has(segs[segs.length - 1])
}





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


export function sumCounts(list) {
  const total = new Map()
  for (const m of list) for (const [t, c] of m) total.set(t, (total.get(t) || 0) + c)
  return total
}


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


export function loadLocalForms(repo) {
  try {
    const p = path.join(repo, '.repoctx', 'decls.json')
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return null }
}
