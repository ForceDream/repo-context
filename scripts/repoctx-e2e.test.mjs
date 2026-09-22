










import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'repoctx.mjs')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'repoctx-e2e-'))

const write = (rel, text) => {
  const p = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text, 'utf8')
}

write('src/a.rs', [
  'pub trait Runner { fn run(&self) -> u32; }',
  'pub struct Alpha;',
  'impl Runner for Alpha {',
  '    fn run(&self) -> u32 { helper() }',
  '}',
  'pub fn helper() -> u32 { 7 }',
  'pub fn entry() -> u32 {',
  '    let a = Alpha;',
  '    Runner::run(&a) + helper()',
  '}',
].join('\n'))
write('src/b.ts', [
  'export function usedHelper(x: number) { return x + 1 }',
  'export function callerFn(y: number) {',
  '  const localOnlyValue = usedHelper(y)',
  '  return localOnlyValue',
  '}',
].join('\n'))


write('src/other.rs', 'pub fn outsider() -> u32 { helper() }\n')
write('README.md', '# 测试仓库\n\n## 用法\n\ncallerFn 与 helper 会被 impact 覆盖。\n')






write('src/alias_def.rs', 'pub fn original_fn() -> u32 { 1 }\n')
write('src/alias_use.rs', [
  'use crate::alias_def::original_fn as renamed_fn;',
  'pub fn alias_caller() -> u32 { renamed_fn() }',
].join('\n'))


write('src/sc_a.ts', [
  'export function scopedHelper() { return 1 }',
  'export function scopedCaller() { return scopedHelper() }',
].join('\n'))
write('src/sc_b.ts', 'export function scopedHelper() { return 2 }\n')


write('src/lex_a.ts', [
  'export interface LexItem { firstField: number }',
  'export function lexConsumer() { return LexItem }',
].join('\n'))
write('src/lex_b.ts', 'export interface LexItem { secondField: string }\n')


write('src/vis_a.ts', 'export function visTarget() { return 1 }\n')
write('src/vis_b.ts', 'function visTarget() { return 2 }\n')
write('src/vis_c.ts', 'export function visCaller() { return visTarget() }\n')


write('src/ty_a.rs', 'pub struct Cfg { pub retries: u32 }\n')
write('src/ty_b.rs', 'pub fn build_cfg() -> Cfg { Cfg { retries: 1 } }\n')
write('src/imp_user.ts', [
  "import { usedHelper } from './b'",
  'export function impCaller(z: number) { return usedHelper(z) }',
].join('\n'))


const run = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args, '--repo', ROOT], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

test('index：建索引成功，产物可解析，stats 与实体数一致', () => {
  const r = run('index')
  assert.equal(r.code, 0, r.out)
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))
  assert.equal(map.stats.symbols, map.symbols.length)
  assert.equal(map.stats.edges, map.edges.length)
  assert.ok(map.stats.files >= 3, `应索引到 3 个文件，实际 ${map.stats.files}`)
  for (const n of ['helper', 'entry', 'Alpha', 'Runner', 'usedHelper', 'callerFn']) {
    assert.ok(map.symbols.some((s) => s.n === n), `缺符号 ${n}`)
  }
})

test('index：确定性（两次产物逐字节一致）', () => {
  const p = path.join(ROOT, '.repoctx', 'map.json')
  const a = fs.readFileSync(p, 'utf8')
  assert.equal(run('index').code, 0)
  assert.equal(fs.readFileSync(p, 'utf8'), a, '两次 index 产物不一致（混入了时间戳或顺序不稳定？）')
})

test('检索动词：for / symbol / callers / callees / impact / context / tree 都能出结果', () => {
  assert.ok(run('for', 'helper').out.includes('helper'), 'for 应命中 helper')
  assert.ok(run('symbol', 'helper').out.includes('n="helper"'))
  assert.ok(run('callers', 'helper').out.includes('entry'), 'helper 的调用方应有 entry')
  assert.ok(run('callees', 'entry').out.includes('helper'), 'entry 应调用 helper')
  assert.ok(run('impact', 'helper').out.includes('entry'), 'helper 的爆炸半径应含 entry')
  assert.ok(run('context', 'helper').out.includes('helper'))
  assert.ok(run('tree').out.length > 0)
})

test('hubs / amb / impls：枢纽榜、歧义组、接口关系', () => {
  assert.ok(run('hubs', '--top', '5').out.includes('<h '))
  assert.ok(run('amb').out.includes('<amb'))
  const impls = run('impls', 'Runner')
  assert.equal(impls.code, 0, impls.out)
  assert.ok(impls.out.includes('Alpha'), 'Runner 的实现应含 Alpha')
  const rev = run('impls', 'Alpha')
  assert.ok(rev.out.includes('implements="Runner"'), 'Alpha 应显示它实现了 Runner')
})

test('pipeline：阶段计数与 index 产物**一致**（同参同结构，防静默分歧）', () => {
  assert.equal(run('index').code, 0)
  const r = run('pipeline')
  assert.equal(r.code, 0, r.out)
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))
  const p1 = /<phase n="1"[^>]*symbols="(\d+)"/.exec(r.out)
  const p2 = /<phase n="2"[^>]*edges="(\d+)" typeEdges="(\d+)"/.exec(r.out)
  assert.ok(p1 && p2, `阶段输出缺属性：${r.out}`)
  assert.equal(Number(p1[1]), map.stats.symbols, 'pipeline 与 index 的符号数必须一致')

  assert.equal(Number(p2[1]), map.stats.edges, 'pipeline 与 index 的调用边数必须一致（漏传 aliases 会在这里失败）')
  assert.equal(Number(p2[2]), map.stats.typeEdges, '类型边数必须一致')

  const out = path.join(ROOT, 'derived')
  assert.equal(run('pipeline', '--out', out).code, 0)
  const cg = JSON.parse(fs.readFileSync(path.join(out, 'call_graph.json'), 'utf8'))
  assert.equal(cg.edges.length, map.stats.edges)
  assert.equal(cg.typeEdges.length, map.stats.typeEdges)
  const im = JSON.parse(fs.readFileSync(path.join(out, 'imports.json'), 'utf8'))
  assert.ok(Object.keys(im.imports).length > 0, `导入绑定派生视图应非空：${JSON.stringify(im.imports)}`)
})

test('resolveSymbol：模糊命中必须自我披露（不许静默用近似名）', () => {
  const exact = run('callers', 'usedHelper')
  assert.ok(!exact.out.includes('模糊匹配'), `精确命中不得出现模糊提示：${exact.out}`)
  const fuzzy = run('callers', 'usedhelpe')
  assert.ok(fuzzy.out.includes('模糊匹配'), `模糊命中必须自我披露（否则闭包看起来正常、实则是另一个符号）：${fuzzy.out}`)
})

test('affected：--files 取值标志解析正确（曾经掉进位置参数 → seeds=0）', () => {
  const r = run('affected', '--files', 'src/a.rs', '--depth', '1', '--top', '20')
  assert.equal(r.code, 0, r.out)
  const m = /files="(\d+)" seeds="(\d+)" affected="(\d+)"/.exec(r.out)
  assert.ok(m, `输出缺属性：${r.out}`)
  assert.equal(m[1], '1', '应恰好 1 个文件')
  assert.ok(Number(m[2]) >= 1, `seeds 必须 ≥1（标志解析失败会静默为 0）：${r.out}`)
  assert.ok(Number(m[3]) >= 1, `affected 必须 ≥1：${r.out}`)
  assert.ok(r.out.includes('outsider'), `改动文件之外、依赖它的符号应出现在受影响清单里：${r.out}`)
})

test('UFCS：`Trait::method(x)` 经 qname 消解成边（prov=qname，严格模式不回落裸名）', () => {

  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))
  const nameOf = (i) => map.symbols[i].q || map.symbols[i].n
  const qn = map.edges.filter((e) => e.prov === 'qname')
  assert.ok(qn.length >= 1, `fixture 里应有 prov=qname 的边，实际边类型：${[...new Set(map.edges.map((e) => e.prov))].join(',')}`)
  const toRun = qn.filter((e) => nameOf(e.to) === 'Runner::run')
  assert.equal(toRun.length, 1, `应恰好一条指向 Runner::run 的 qname 边，实际 ${JSON.stringify(qn.map((e) => nameOf(e.to)))}`)
  assert.equal(nameOf(toRun[0].from), 'entry', '调用方应是 entry')

  const toAlphaRun = map.edges.filter((e) => nameOf(e.to) === 'Alpha::run')
  assert.equal(toAlphaRun.length, 0, `限定路径已说明意图，不应回落裸名连到 Alpha::run：${JSON.stringify(toAlphaRun)}`)
})





const artifact = () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))
  const label = (i) => {
    const s = map.symbols[i]
    return `${s.p.split('/').pop()}::${s.q || s.n}`
  }
  const edgesOf = (prov) => map.edges.filter((e) => e.prov === prov).map((e) => `${label(e.from)} → ${label(e.to)}`)
  return { map, label, edgesOf }
}

test('prov=alias：`use … as` 别名兜底指向原名（且不冒充裸名边）', () => {
  assert.equal(run('index').code, 0)
  const { edgesOf } = artifact()
  assert.deepEqual(edgesOf('alias'), ['alias_use.rs::alias_caller → alias_def.rs::original_fn'],
    '别名边应恰好一条：alias_caller → original_fn（原名，不是别名）')
})

test('prov=scope-unique：撞名 ≤3 且本文件唯一候选 → 连本文件那个', () => {
  const { edgesOf } = artifact()
  assert.deepEqual(edgesOf('scope-unique'), ['sc_a.ts::scopedCaller → sc_a.ts::scopedHelper'],
    '应连本文件的 scopedHelper，而不是 sc_b.ts 的同名项')
})

test('prov=lexical：本文件唯一顶层非 var/const 候选 → 词法遮蔽', () => {
  const { edgesOf } = artifact()
  assert.deepEqual(edgesOf('lexical'), ['lex_a.ts::lexConsumer → lex_a.ts::LexItem'],
    '词法作用域：本文件的 LexItem 遮蔽 lex_b.ts 的同名 iface')
})

test('prov=visibility：跨文件唯一"可见"候选胜出（未 export 的在 TS 里不可见）', () => {
  const { edgesOf, map } = artifact()
  assert.deepEqual(edgesOf('visibility'), ['vis_c.ts::visCaller → vis_a.ts::visTarget'],
    '应连 export 过的 vis_a.ts::visTarget，而不是未 export 的 vis_b.ts')

  const callerIdx = map.symbols.findIndex((s) => s.n === 'visCaller')
  const bad = map.edges.filter((e) => e.from === callerIdx && map.symbols[e.to].p === 'src/vis_b.ts')
  assert.equal(bad.length, 0, `不可见目标不应连边：${JSON.stringify(bad)}`)
})

test('typerefs：类型引用族——"谁引用了这个类型"，且**不进调用图**', () => {
  assert.equal(run('index').code, 0)
  const r = run('typerefs', 'Cfg', '--top', '10')
  assert.equal(r.code, 0, r.out)
  assert.ok(/inEdges="[1-9]/.test(r.out), `Cfg 应有类型引用入边：${r.out}`)
  assert.ok(r.out.includes('build_cfg'), `入边应含 build_cfg（它在返回类型位引用了 Cfg）：${r.out}`)
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))

  const viaCall = map.edges.filter((e) => map.symbols[e.to].n === 'Cfg').map((e) => map.symbols[e.from].n)
  assert.deepEqual(viaCall, [], `调用图不得有指向 Cfg 的边（类型引用走 typeEdges）：${JSON.stringify(viaCall)}`)
  assert.ok((map.typeEdges || []).some((e) => map.symbols[e.to].n === 'Cfg'), '类型边族里应有指向 Cfg 的边')

  const retries = map.symbols.find((s) => s.n === 'retries')
  assert.equal(retries.t, 'field')
  assert.equal(retries.q, 'Cfg::retries')
})

test('impact --types：把类型引用边纳入爆炸半径（逐条标 via="type"）', () => {
  assert.equal(run('index').code, 0)
  const plain = run('impact', 'Cfg', '--depth', '1')
  const withTypes = run('impact', 'Cfg', '--depth', '1', '--types')
  assert.equal(plain.code, 0, plain.out)
  assert.equal(withTypes.code, 0, withTypes.out)
  assert.ok(!plain.out.includes('via="type"'), `默认口径不得混入类型引用边：${plain.out}`)
  assert.ok(!plain.out.includes('build_cfg'), `默认闭包不该含 build_cfg（它只与 Cfg 有类型关系）：${plain.out}`)
  assert.ok(/viaType="[1-9]/.test(withTypes.out), `--types 应报告 viaType 计数：${withTypes.out}`)
  assert.ok(withTypes.out.includes('build_cfg') && withTypes.out.includes('via="type"'),
    `--types 后 build_cfg 应作为类型引用方出现并标注 via="type"：${withTypes.out}`)
})

test('context：机器事实含类型引用族（in/out）与导入绑定', () => {
  const r = run('context', 'Cfg')
  assert.equal(r.code, 0, r.out)
  assert.ok(/<typerefs in="[1-9]/.test(r.out), `context 应给出类型引用入边：${r.out}`)
  assert.ok(r.out.includes('build_cfg'), `类型引用入边应含 build_cfg：${r.out}`)
})

test('imports：谁导入了这个符号（依赖面，AST 导入绑定）', () => {
  const r = run('imports', 'usedHelper')
  assert.equal(r.code, 0, r.out)
  assert.ok(/files="[1-9]/.test(r.out), `应有一个文件导入它：${r.out}`)
  assert.ok(r.out.includes('src/imp_user.ts'), `应列出导入它的文件：${r.out}`)
})

test('产物版本护栏：旧 schema 的 map.json 必须显式失败（不许静默读错字段）', () => {
  assert.equal(run('index').code, 0)
  const f = path.join(ROOT, '.repoctx', 'map.json')
  const good = fs.readFileSync(f, 'utf8')
  const bad = good.replace('"schema":"repoctx/2"', '"schema":"repoctx/1"')
  assert.notEqual(bad, good, `产物里应有 schema 字段（当前契约 repoctx/2）：${good.slice(0, 120)}`)
  fs.writeFileSync(f, bad, 'utf8')
  const r = run('callers', 'helper')
  assert.notEqual(r.code, 0, '旧版本产物必须拒绝读取（缺 typeEdges/imports 会给出看起来正常的错答案）')
  assert.ok(r.out.includes('版本不符'), r.out)
  fs.writeFileSync(f, good, 'utf8')
  assert.equal(run('callers', 'helper').code, 0)
})

test('邻接索引（P2-5）：callers 计数口径与产物入度一致', () => {
  assert.equal(run('index').code, 0)
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, '.repoctx', 'map.json'), 'utf8'))
  const idx = map.symbols.findIndex((s) => s.n === 'helper')
  const deg = map.edges.filter((e) => e.prov !== 'doc' && e.to === idx).length
  const m = /<callers of="helper" n="(\d+)"/.exec(run('callers', 'helper').out)
  assert.ok(m, 'callers 输出缺 n=')
  assert.equal(Number(m[1]), deg, 'callers 计数必须等于产物入度（预构建邻接表口径，P2-5 后新增护栏）')
})

test('tree：按文件列出枢纽符号', () => {
  const r = run('tree', '--top', '5')
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('src/a.rs'), `tree 应列出已索引文件：${r.out.slice(0, 300)}`)
})

test('note --file：文件级笔记能被 context 带出', () => {
  assert.equal(run('note', '--file', 'src/a.rs', '--text', '文件级笔记：改 a.rs 要注意 helper').code, 0)
  assert.ok(run('notes', '--contains', '文件级笔记').out.includes('文件级笔记'))
  assert.ok(run('context', 'helper').out.includes('文件级笔记'), 'context 应带出同文件的人写笔记')
})


write('src/amb_pair.rs', [
  'pub struct PairType { pub left_side: u32 }',
  'impl PairType { pub fn build_pair() -> PairType { PairType { left_side: 1 } } }',
].join('\n'))
write('src/amb_pair2.rs', 'pub struct PairType { pub right_side: u32 }\n')

write('src/amb_use.rs', 'pub fn use_pair_type() -> u32 { let _tmp = PairType; 1 }\n')

test('files：文件级度量（--by size|syms|cx、--dir 过滤、非法维度显式失败）', () => {
  assert.equal(run('index').code, 0)
  const r = run('files', '--by', 'cx')
  assert.equal(r.code, 0, r.out)
  assert.ok(/<files by="cx" n="\d+" total="\d+"/.test(r.out), `缺头部：${r.out}`)
  assert.ok(/cxMax="\d+" cxSum="\d+"/.test(r.out), `每行须带 cxMax/cxSum：${r.out}`)
  const rows = [...r.out.matchAll(/<f p="([^"]+)" lang="([^"]+)" bytes="(\d+)" syms="(\d+)" cxMax="(\d+)" cxSum="(\d+)"/g)]
  assert.ok(rows.length > 0, `缺文件行：${r.out}`)
  assert.ok(rows.every((m) => m[5] !== '' && m[6] !== ''), 'cxMax/cxSum 必须是数字（不是空串）')

  const d = run('files', '--dir', 'src')
  assert.equal(d.code, 0, d.out)
  const paths = [...d.out.matchAll(/<f p="([^"]+)"/g)].map((m) => m[1])
  assert.ok(paths.length > 0 && paths.every((p) => p.startsWith('src/')), `--dir 应只列该子树：${JSON.stringify(paths)}`)

  const bad = run('files', '--by', 'bogus')
  assert.notEqual(bad.code, 0, '未知 --by 必须非零退出')
  assert.ok(bad.out.includes('未知 --by'), bad.out)
})

test('amb NAME：impl 块单独标注（"类型 + 其 impl"不是重复定义）', () => {
  assert.equal(run('index').code, 0)
  const r = run('amb', 'PairType')
  assert.equal(r.code, 0, r.out)
  assert.ok(/defs="3" impls="1"/.test(r.out), `应把 1 个 impl 从 3 条定义里拆出来标注：${r.out}`)
  assert.ok(r.out.includes('不是重复定义'), `note 必须解释 impl 的命名语义：${r.out}`)

  const list = run('amb', '--top', '80')
  assert.ok(/<g n="PairType" defs="3" impls="1"/.test(list.out), `组列表也应带 impls=：${list.out}`)
})



write('docs/guide-a.md', '# 指南 A\n\n## ambdocmarker\n\n见 ambdocmarker 的说明。\n')
write('docs/guide-b.md', '# 指南 B\n\n## ambdocmarker\n\n另一份文档。\n')

test('amb：文档段落（md 标题）撞名**不算代码歧义**——纯文档组默认隐藏、--docs 可见、单组带 doc= 标注', () => {
  assert.equal(run('index').code, 0)
  const list = run('amb')
  assert.equal(list.code, 0, list.out)
  const hidden = /docsHidden="(\d+)"/.exec(list.out)
  assert.ok(hidden, `amb 头部必须披露被隐藏的纯文档组数：${list.out}`)
  assert.ok(Number(hidden[1]) >= 1, `fixture 里应有纯文档组（实际 docsHidden=${hidden && hidden[1]}）`)
  assert.ok(!list.out.includes('n="ambdocmarker"'), '纯文档组不应出现在默认列表里')
  assert.ok(list.out.includes('纯文档组默认隐藏'), 'note 要说明隐藏原因与放开方式')


  const withDocs = run('amb', '--docs', '--top', '80')
  assert.equal(withDocs.code, 0, withDocs.out)
  assert.ok(/docsHidden="0"/.test(withDocs.out) && /docs="1"/.test(withDocs.out), `--docs 应放开并标记：${withDocs.out}`)
  const n1 = Number(/groups="(\d+)"/.exec(list.out)[1])
  const n2 = Number(/groups="(\d+)"/.exec(withDocs.out)[1])
  assert.ok(n2 > n1, `--docs 的组数应多于默认（${n1} → ${n2}）`)
  assert.ok(/<g n="ambdocmarker" defs="2" doc="2"/.test(withDocs.out), `文档组要带 doc= 标注：${withDocs.out}`)


  const one = run('amb', 'ambdocmarker')
  assert.equal(one.code, 0, one.out)
  assert.ok(/n="ambdocmarker" defs="2" doc="2"/.test(one.out), one.out)
  assert.ok(one.out.includes('全部来自文档段落'), `note 要指出这是文档撞名：${one.out}`)
})


write('src/cxown.rs', [
  'pub fn outer_fn() -> u32 {',
  '    fn inner_fn() -> u32 { if true { 1 } else { 2 } }',
  '    inner_fn()',
  '}',
  '',
  'pub fn leaf_fn() -> u32 { 7 }',
].join('\n'))

write('src/dupa/same_named.rs', 'pub fn in_dupa() -> u32 { 1 }\n')
write('src/dupb/same_named.rs', 'pub fn in_dupb() -> u32 { 2 }\n')

test('cxOwn：容器符号扣除嵌套定义的分支数（cxOwn < cx；叶子符号不显示）', () => {
  assert.equal(run('index').code, 0)
  const outer = run('symbol', 'outer_fn')
  assert.equal(outer.code, 0, outer.out)
  const m = /cx="(\d+)" cxOwn="(\d+)"/.exec(outer.out)
  assert.ok(m, `容器符号应同时带 cx 与 cxOwn：${outer.out}`)
  assert.ok(Number(m[2]) < Number(m[1]), `cxOwn 应小于 cx（嵌套部分归子符号）：${outer.out}`)

  const leaf = run('symbol', 'leaf_fn')
  assert.equal(leaf.code, 0, leaf.out)
  assert.ok(!/cxOwn=/.test(leaf.out), `叶子符号不应带 cxOwn：${leaf.out}`)
})

test('files --by dupes：同名文件分组（同名 ≠ 副本，仅提供线索）', () => {
  const r = run('files', '--by', 'dupes')
  assert.equal(r.code, 0, r.out)
  assert.ok(/<dupes groups="\d+"/.test(r.out), `缺头部：${r.out}`)
  assert.ok(r.out.includes('同名 ≠ 副本'), 'note 必须警示"同名 ≠ 副本"')
  assert.ok(/<d name="same_named\.rs" copies="2">/.test(r.out), `应列出同名组：${r.out}`)
  assert.ok(/p="src\/dupa\/same_named\.rs"/.test(r.out) && /p="src\/dupb\/same_named\.rs"/.test(r.out), r.out)
})

test('note / notes：经验可写入、可按符号查回、可全文搜', () => {
  assert.equal(run('note', '--sym', 'helper', '--text', '阈值改动会静默改变历史结论').code, 0)
  assert.ok(run('notes', '--sym', 'helper').out.includes('阈值改动'))
  assert.ok(run('notes', '--contains', '静默').out.includes('阈值改动'))
})

test('export / check：人读版可生成，且产物与源码一致（0 漂移）', () => {
  assert.equal(run('export').code, 0)
  const md = path.join(ROOT, '.repoctx', 'MAP.md')
  assert.ok(fs.existsSync(md), 'export 应生成 MAP.md')
  assert.ok(fs.readFileSync(md, 'utf8').includes('规模'), 'MAP.md 应含规模行')
  assert.equal(run('check').code, 0, '未改动源码时 check 必须通过')
})

test('check：源码改动后必须报漂移（非 0 退出）', () => {
  fs.appendFileSync(path.join(ROOT, 'src', 'a.rs'), '\npub fn added_later() -> u32 { 1 }\n', 'utf8')
  const r = run('check')
  assert.notEqual(r.code, 0, '改了源码但 check 仍通过 → 漂移门禁失效')
  assert.ok(/漂移/.test(r.out), r.out)
  assert.equal(run('index').code, 0, '重建应恢复一致')
  assert.equal(run('check').code, 0)
})

test('清理 fixture', () => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  assert.ok(!fs.existsSync(ROOT))
})
