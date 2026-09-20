/**
 * 声明层测试（2026-09-16）：登记表自检 / 筛子 / 分类 / 普查端到端
 *
 * 这一层的价值全在"**漏掉的形态会自己冒出来**"，所以测试的重点不是"某个函数返回什么"，
 * 而是：① 登记表不许漂移（extracted ⟺ 抽取器实际用的表）；② 筛子既不能漏（`type_annotation`
 * 必须命中）也不能脏（`property_identifier` 必须不命中——首跑时它 12.8 万次霸榜，把真缺口挤下去）；
 * ③ 真出现未登记形态时，普查**必须报出来**（这是整层的存在理由，也是"缺了能补"的入口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DECL_FORMS, KIND_UNIVERSE, LANG_DECLS, classifyCounts, formsLangKey, formsOf, isDeclLike, selfCheck } from './repoctx-decls.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = path.join(HERE, 'repoctx-decl-audit.mjs')
const WASM = path.join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out')
const hasAst = fs.existsSync(WASM)

test('登记表自检：extracted ⟺ LANG_DECLS，kind 在全集内，planned/skipped 必写理由', () => {
  const problems = selfCheck()
  assert.deepEqual(problems, [], `登记表与抽取器漂移：\n${problems.join('\n')}`)
})

test('登记表：LANG_DECLS 的每一类都在登记表里，且 kind 落在 KIND_UNIVERSE', { skip: !hasAst }, () => {
  for (const lang of Object.keys(LANG_DECLS)) {
    const forms = formsOf(lang)
    for (const [node, kind] of LANG_DECLS[lang]) {
      assert.ok(forms.has(node), `${lang}: ${node} 未登记`)
      assert.equal(forms.get(node).kind, kind, `${lang}: ${node} kind 不一致`)
      assert.ok(KIND_UNIVERSE.has(kind), `${lang}: ${node} 的 kind=${kind} 不在全集`)
    }
  }
})

test('筛子：声明样形态命中（含首跑发现的缺口），非声明节点不命中', () => {
  // 必须命中——这些正是"待补/新发现"的两类：类型层与字段层
  for (const t of ['type_annotation', 'opting_type_annotation', 'type_predicate_annotation', 'type_identifier',
    'public_field_definition', 'field_declaration', 'enum_variant', 'property_signature',
    'variable_declarator', 'required_parameter', 'constrained_type_parameter', 'import_specifier', 'import_clause']) {
    assert.ok(isDeclLike(t), `${t} 应当被判为声明样`)
  }
  // 必须不命中——首跑时这些噪声占了榜首（12.8 万次 property_identifier），一次筛子收紧才清净
  for (const t of ['property_identifier', 'member_expression', 'else_clause', 'catch_clause',
    'identifier', 'block', 'call_expression', 'type_arguments', 'regex_pattern', 'string']) {
    assert.ok(!isDeclLike(t), `${t} 不应被判为声明样（会淹没真缺口）`)
  }
})

test('分类：五类分桶正确、按量级排序、非声明样节点被忽略', () => {
  // 注意用**同一语言的**节点（type_annotation 是 TS 形态，在 rust 登记表里不存在——
  // 首版测试就踩了这个：拿 rust 去分类 TS 形态，结果全部落进 unclassified）
  const counts = new Map([
    ['function_declaration', 10],  // ts extracted（符号形态）
    ['type_annotation', 5],        // ts covered（非符号，类型名经 trefs 进类型边族）
    ['variable_declarator', 3],    // ts skipped
    ['brand_new_item', 7],         // 未登记但声明样（后缀 item）→ unclassified
    ['property_identifier', 999],  // 非声明样 → 完全不出现
  ])
  const cls = classifyCounts('ts', counts)
  assert.deepEqual(cls.extracted.map((x) => x.node), ['function_declaration'])
  assert.deepEqual(cls.covered.map((x) => x.node), ['type_annotation'], 'covered = 被机制覆盖的非符号形态')
  assert.deepEqual(cls.skipped.map((x) => x.node), ['variable_declarator'])
  assert.deepEqual(cls.unclassified.map((x) => x.node), ['brand_new_item'], '未登记的声明样形态必须冒出来')
  assert.ok(cls.covered[0].why, 'covered 必须写清是**哪个机制**覆盖的')
  const many = classifyCounts('ts', new Map([['type_annotation', 1], ['import_specifier', 9]]))
  assert.deepEqual(many.covered.map((x) => x.node), ['import_specifier', 'type_annotation'], '按出现次数降序')
  // rust 侧同样分桶（跨语言互不串味）
  const rs = classifyCounts('rust', new Map([['function_item', 2], ['field_declaration', 4], ['use_declaration', 3], ['let_declaration', 1]]))
  assert.deepEqual(rs.extracted.map((x) => x.node), ['field_declaration', 'function_item'], '字段已于第四十九轮补成符号（按量级降序）')
  assert.deepEqual(rs.covered.map((x) => x.node), ['use_declaration'], '导入声明 → 导入绑定（covered）')
  assert.deepEqual(rs.skipped.map((x) => x.node), ['let_declaration'])
})

test('聚合键：tsx→ts、jsx→js（同一份登记表不许按扩展名分开比对，否则出现假过期）', () => {
  assert.equal(formsLangKey('tsx'), 'ts')
  assert.equal(formsLangKey('jsx'), 'js')
  assert.equal(formsLangKey('rust'), 'rust')
})

test('普查端到端：fixture 里的类型标注与字段被报为"待补"，且未登记形态会冒出来', { skip: !hasAst }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoctx-decls-'))
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), [
      'interface Cfg { retries: number }',
      'export function loadCfg(name: string): Cfg { return { retries: 1 } }',
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(root, 'src', 'b.rs'), [
      'pub struct Cfg { pub retries: u32 }',
      'pub fn build_cfg(times: u32) -> Cfg { Cfg { retries: times } }',
    ].join('\n'), 'utf8')
    const out = execFileSync(process.execPath, [AUDIT, '--repo', root, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    const j = JSON.parse(out)
    const nodes = (bucket) => j.merged.filter((x) => x.bucket === bucket).map((x) => x.node)
    // 第四十九轮后：这些都是"已抽/已覆盖"，不再是待补
    assert.ok(nodes('covered').includes('type_annotation'), `类型标注应由 trefs 机制覆盖：${nodes('covered')}`)
    assert.ok(nodes('covered').includes('type_identifier'), `类型引用应由类型边族覆盖：${nodes('covered')}`)
    assert.ok(nodes('extracted').includes('field_declaration'), `Rust 字段应已抽成符号：${nodes('extracted')}`)
    assert.ok(nodes('extracted').includes('function_declaration'), '已抽形态应出现在 extracted 桶')
    assert.deepEqual(j.problems, [], '登记表自检必须一致')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('本仓库普查：登记表全量覆盖——未归类 0 且**待补 0**（第四十九轮补齐后）', { skip: !hasAst }, () => {
  const repo = path.resolve(HERE, '..', '..', '..')
  if (!fs.existsSync(path.join(repo, '.repoctx', 'map.json'))) return // 无索引则不跑（保持零依赖可用）
  const out = execFileSync(process.execPath, [AUDIT, '--repo', repo, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const j = JSON.parse(out)
  const pick = (b) => j.merged.filter((x) => x.bucket === b)
  assert.deepEqual(pick('unclassified').map((x) => `${x.lang}:${x.node}`), [],
    '出现未登记的声明样形态 → 请归类进 repoctx-decls.mjs 的 DECL_FORMS（extracted/covered/skipped）')
  assert.deepEqual(pick('planned').map((x) => `${x.lang}:${x.node}`), [],
    '补齐清单必须为空：待补 = 已知但没做；第四十九轮后所有形态要么抽了（extracted）、要么被机制覆盖（covered）、要么明确不抽（skipped）')
  assert.ok(pick('covered').length > 0, '应有被机制覆盖的形态（类型引用/导入绑定等）')
  assert.ok(pick('covered').every((x) => x.why), '每条 covered 都必须写清是哪个机制')
  assert.deepEqual(j.problems, [])
})

test('登记表：planned/skipped 都必须有 why（否则等于没登记）', () => {
  for (const lang of Object.keys(DECL_FORMS)) {
    for (const f of DECL_FORMS[lang]) {
      if (f.status === 'extracted') continue
      assert.ok(f.why && f.why.length > 6, `${lang}:${f.node}（${f.status}）缺理由`)
    }
  }
})
