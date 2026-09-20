/**
 * 产物自一致性测试（2026-09-16）
 *
 * 动机：这类"内部账不平"的错误会**静默**产出错误结论——本轮就发生过一次
 * （探针脚本少一对花括号 → 分桶合计 10511 ≠ 总数 5500，靠"打印桶合计 vs 总数"才抓出来）。
 * 这里把同类自校验固化到工具产物上：边数/歧义数/引用数必须互相吻合，索引必须指向合法符号。
 *
 * 覆盖对象：
 *   · REPOCTX_TEST_REPO（若设了环境变量）或测试文件所在仓库（tools/repo-context/scripts → 上溯三级）；
 *   · 两个对象都没有 map.json 时自动 skip。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CANDIDATES = [process.env.REPOCTX_TEST_REPO, path.resolve(HERE, '..', '..', '..')].filter(Boolean)
const MAP_FILE = CANDIDATES.map((r) => path.join(r, '.repoctx', 'map.json')).find((p) => fs.existsSync(p))
const skip = MAP_FILE ? false : '无索引产物（先跑 repoctx index）'
const map = MAP_FILE ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : null

const KNOWN_PROV = new Set(['name', 'same-file', 'doc', 'scope-unique', 'lexical', 'visibility', 'alias', 'qname', 'dispatch', 'propagated'])
const KNOWN_KINDS = new Set(['fn', 'method', 'class', 'iface', 'struct', 'enum', 'trait', 'type', 'mod', 'var', 'const', 'macro', 'impl', 'field', 'variant', 'prop', 'sec'])
/** 成员类符号：是符号，但**不得成为调用图的边目标**（见 repoctx.mjs MEMBER_KINDS 注释） */
const MEMBER_KINDS = new Set(['field', 'prop', 'variant'])

test('计数自洽：sum(ambRefs) === stats.ambiguous', { skip }, () => {
  const sum = Object.values(map.ambRefs || {}).reduce((a, b) => a + b, 0)
  assert.equal(sum, map.stats.ambiguous, `ambRefs 合计 ${sum} 与 stats.ambiguous ${map.stats.ambiguous} 不一致（计数写入漏了一处？）`)
})

test('计数自洽：按 prov 分组的边数合计 === edges.length === stats.edges', { skip }, () => {
  const byProv = {}
  for (const e of map.edges) byProv[e.prov] = (byProv[e.prov] || 0) + 1
  const sum = Object.values(byProv).reduce((a, b) => a + b, 0)
  assert.equal(sum, map.edges.length)
  assert.equal(map.edges.length, map.stats.edges, `stats.edges=${map.stats.edges} 与实际 ${map.edges.length} 不一致`)
  for (const p of Object.keys(byProv)) assert.ok(KNOWN_PROV.has(p), `未知 prov：${p}`)
})

test('边的端点必须指向合法符号，且不自环', { skip }, () => {
  const n = map.symbols.length
  for (const e of map.edges) {
    assert.ok(Number.isInteger(e.from) && e.from >= 0 && e.from < n, `非法 from=${e.from}`)
    assert.ok(Number.isInteger(e.to) && e.to >= 0 && e.to < n, `非法 to=${e.to}`)
    if (e.prov !== 'dispatch') assert.notEqual(e.from, e.to, `自环边（prov=${e.prov}）`)
  }
})

test('边不重复（同 from/to/prov 只出现一次）', { skip }, () => {
  const seen = new Set()
  for (const e of map.edges) {
    const k = `${e.from}>${e.to}#${e.prov}`
    assert.ok(!seen.has(k), `重复边：${k}`)
    seen.add(k)
  }
})

test('符号字段合法（路径/行号/种类/名字），且无重复定义', { skip }, () => {
  const seen = new Set()
  for (const s of map.symbols) {
    assert.ok(typeof s.p === 'string' && s.p.length > 0, '符号缺路径')
    assert.ok(Number.isInteger(s.l) && s.l >= 1, `非法行号：${s.n}@${s.p}:${s.l}`)
    assert.ok(Number.isInteger(s.el) && s.el >= s.l, `endLine < line：${s.n}@${s.p}:${s.l}-${s.el}`)
    assert.ok(KNOWN_KINDS.has(s.t), `未知 kind：${s.t}`)
    assert.ok(typeof s.n === 'string' && s.n.length > 0, '符号缺名字')
    const k = `${s.p}|${s.l}|${s.n}|${s.t}`
    assert.ok(!seen.has(k), `重复符号：${k}`)
    seen.add(k)
  }
})

test('每个符号的路径必须在 files 清单里；files 计数一致', { skip }, () => {
  const files = new Set(map.files.map((f) => f.p))
  assert.equal(map.files.length, map.stats.files)
  for (const s of map.symbols) assert.ok(files.has(s.p), `符号落在未索引文件：${s.p}`)
})

test('调用图纯度：成员类符号（field/prop/variant）不得成为调用边目标', { skip }, () => {
  // 这条守的是"调用图"的语义边界：字段/接口属性/枚举变体不是可调用目标，
  // 且它们的名字（data/id/name/error…）在仓库里成百上千处重名——放任进来会让未连歧义从 2.1k 涨到 10.4k
  // （实测）。它们仍是符号（symbol/typerefs/imports 能查），只是不参与调用解析。
  const bad = map.edges.filter((e) => MEMBER_KINDS.has(map.symbols[e.to].t))
  assert.deepEqual(bad.slice(0, 5).map((e) => `${map.symbols[e.from].n} → ${map.symbols[e.to].n}(${map.symbols[e.to].t})`), [],
    `调用边不得指向成员类符号（共 ${bad.length} 条）`)
})

test('类型边族自洽：端点是合法类型的符号、不自环、不重复、prov=type', { skip }, () => {
  const te = map.typeEdges || []
  assert.ok(map.stats.typeEdges === undefined || map.stats.typeEdges === te.length,
    `stats.typeEdges=${map.stats.typeEdges} 与实际 ${te.length} 不一致`)
  const n = map.symbols.length
  const TYPE_KINDS = new Set(['struct', 'enum', 'trait', 'type', 'iface', 'class'])
  const seen = new Set()
  for (const e of te) {
    assert.ok(Number.isInteger(e.from) && e.from >= 0 && e.from < n, `非法 from=${e.from}`)
    assert.ok(Number.isInteger(e.to) && e.to >= 0 && e.to < n, `非法 to=${e.to}`)
    assert.notEqual(e.from, e.to, '类型边不得自环')
    assert.equal(e.prov, 'type')
    assert.ok(TYPE_KINDS.has(map.symbols[e.to].t), `类型边的目标必须是类型定义，实际 ${map.symbols[e.to].t}`);
    const k = `${e.from}>${e.to}`
    assert.ok(!seen.has(k), `类型边重复：${k}`)
    seen.add(k)
  }
})

test('导入绑定自洽：每个键都是已索引文件，值是简单名数组', { skip }, () => {
  const files = new Set(map.files.map((f) => f.p))
  for (const [f, names] of Object.entries(map.imports || {})) {
    assert.ok(files.has(f), `导入绑定落在未索引文件：${f}`)
    assert.ok(Array.isArray(names) && names.length > 0, `导入名清单必须是非空数组：${f}`)
    for (const nm of names) assert.match(nm, /^[A-Za-z_$][\w$]*$/, `导入名必须是简单名：${nm}`)
  }
})

test('ambRefs 的每个键都真有 ≥2 个定义（否则不该计歧义）', { skip }, () => {
  const cnt = new Map()
  for (const s of map.symbols) cnt.set(s.n, (cnt.get(s.n) || 0) + 1)
  for (const [name, refs] of Object.entries(map.ambRefs || {})) {
    assert.ok(refs > 0, `${name} 计数为 ${refs}`)
    assert.ok((cnt.get(name) || 0) >= 2, `${name} 只有 ${cnt.get(name) || 0} 个定义，不该在 ambRefs 里`)
  }
})

test('stats 数值健全（无 NaN/负数），且 localOnly 与 ambiguous 都是数', { skip }, () => {
  for (const k of ['files', 'symbols', 'edges', 'ambiguous', 'localOnly', 'bodyChars']) {
    const v = map.stats[k]
    assert.ok(typeof v === 'number' && Number.isFinite(v) && v >= 0, `stats.${k}=${v} 不合法`)
  }
  assert.equal(map.stats.symbols, map.symbols.length)
})

test('schema 字段存在且 root 不写绝对路径（可跨机器比对）', { skip }, () => {
  assert.ok(map.schema, '缺 schema')
  assert.equal(map.root, '.', `root 必须是 '.'（实测 ${map.root}）`)
})
