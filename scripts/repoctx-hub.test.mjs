









import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GENERIC_NAMES, KIND_WEIGHT, DEFAULT_CONFIG,
  loadHubConfig, isVendorPath, isTestPath, stripNoise, createHubModel, hubNormTable,
} from './repoctx-hub.mjs'


const sym = (n, o = {}) => ({
  n,
  t: o.t || 'fn',
  p: o.p || 'src/app.rs',
  l: o.l ?? 10,
  el: o.el ?? (o.l ?? 10) + 4,
  local: o.local || false,
  cx: 1,
})

const model = (symbols, edges, hub = {}) =>
  createHubModel({ symbols, edges, config: { ...DEFAULT_CONFIG, ...hub } })



test('stripNoise：剥注释与字符串，但不误伤 URL 与代码本体', () => {
  assert.ok(!stripNoise('let a = 1 // push\nlet b = 2', 'js').includes('push'), '行注释')
  assert.ok(!stripNoise('/* push */\nlet a = 1', 'js').includes('push'), '块注释')
  assert.ok(!stripNoise('let s = "push"', 'js').includes('push'), '双引号串')
  assert.ok(!stripNoise("let s = 'push'", 'js').includes('push'), '单引号串')
  assert.ok(!stripNoise('let s = `push`', 'js').includes('push'), '模板串')
  assert.ok(!stripNoise('x = 1  # push', 'py').includes('push'), 'Python 井号注释')
  assert.ok(stripNoise('const u = http://push', 'js').includes('push'), 'http:// 的 // 不是注释起点')
  assert.ok(stripNoise('let a = push(x)', 'js').includes('push'), '代码本体不受影响')
})



test('路径分级：第三方路径与测试路径的判定（含反例）', () => {
  for (const p of ['node_modules/x/index.js', 'src/vendor/a.rs', 'third_party/z.cpp', '.cargo/registry/src/lib.rs', 'lib/site-packages/m.py']) {
    assert.equal(isVendorPath(p), true, `应判为第三方：${p}`)
  }
  assert.equal(isVendorPath('src/lib/repoctx.mjs'), false)
  assert.equal(isVendorPath('server/src/agent/tool.rs'), false)

  for (const p of ['src/tests/a.ts', 'test/b.js', 'a.test.ts', 'spec/c.ts', 'bench/d.rs']) {
    assert.equal(isTestPath(p), true, `应判为测试：${p}`)
  }
  assert.equal(isTestPath('src/latest.ts'), false, 'latest 含 test 但不是测试路径')
  assert.equal(isTestPath('src/agent/state.rs'), false)
})



test('loadHubConfig：缺失用默认、坏 JSON 必须报错而不是静默', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repoctx-hub-'))
  const missing = loadHubConfig(dir)
  assert.deepEqual(
    [missing.whitelist, missing.genericDamp, missing.testDamp, missing.vendorDamp],
    [[], DEFAULT_CONFIG.genericDamp, DEFAULT_CONFIG.testDamp, DEFAULT_CONFIG.vendorDamp],
  )
  assert.equal(missing.source, null)
  assert.equal(missing.error, undefined)

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ hub: { whitelist: ['push', 'len'], genericDamp: 0.3 } }), 'utf8')
  const cfg = loadHubConfig(dir)
  assert.deepEqual(cfg.whitelist, ['push', 'len'])
  assert.equal(cfg.genericDamp, 0.3)
  assert.equal(cfg.testDamp, DEFAULT_CONFIG.testDamp, '未给的键回落默认')

  fs.writeFileSync(path.join(dir, 'config.json'), '{ 坏 json', 'utf8')
  const bad = loadHubConfig(dir)
  assert.ok(bad.error, '坏配置必须带 error（否则用户改了白名单却不生效，无从察觉）')
  assert.equal(bad.genericDamp, DEFAULT_CONFIG.genericDamp)
  fs.rmSync(dir, { recursive: true, force: true })
})



test('局部变量不进候选：score() 返回 null，且不出现在 ranking 里', () => {
  const withLocal = model(
    [sym('helper', { p: 'src/a.rs' }), sym('tmp', { p: 'src/a.rs', t: 'var', local: true })],
    [{ from: 0, to: 1, prov: 'name' }],
  )
  assert.equal(withLocal.score(1), null)
  assert.equal(withLocal.ranking().some((r) => r.i === 1), false)


  const notLocal = model(
    [sym('helper', { p: 'src/a.rs' }), sym('tmp', { p: 'src/a.rs', t: 'var' })],
    [{ from: 0, to: 1, prov: 'name' }],
  )
  assert.ok(notLocal.score(1), '非局部的 var 应进候选')
})

test('第三方路径的定义不进候选', () => {
  const m = model(
    [sym('inner', { p: 'node_modules/pkg/index.js' }), sym('c', { p: 'src/b.rs' })],
    [{ from: 1, to: 0, prov: 'name' }],
  )
  assert.equal(m.score(0), null)
  assert.equal(m.ranking().length, 0)
})

test('文档段落不做枢纽；无入度的符号不进候选', () => {
  const doc = model([sym('s', { p: 'doc/a.md', t: 'sec' }), sym('c', { p: 'doc/a.md' })], [{ from: 1, to: 0, prov: 'doc' }])
  assert.equal(doc.score(0), null)

  const lonely = model([sym('lonely', { p: 'src/a.rs' })], [])
  assert.equal(lonely.score(0), null)
  assert.deepEqual(lonely.ranking(), [])
})



test('泛用名降权：系数精确生效，但**不删除**（callers 仍统计）', () => {
  const one = (name) => model(
    [sym(name, { p: 'src/app.rs' }), sym('caller', { p: 'src/other.rs' })],
    [{ from: 1, to: 0, prov: 'name' }],
  ).score(0)

  const generic = one('push')
  const normal = one('handleThing')
  assert.ok(GENERIC_NAMES.has('push'), '表里必须有 push')
  assert.ok(generic, '泛用名必须仍在候选里（降权≠删除）')
  assert.equal(generic.callers, 1, '入度仍然统计')
  assert.ok(Math.abs(generic.score / normal.score - DEFAULT_CONFIG.genericDamp) < 1e-12, '比值应恰为 genericDamp')
  assert.ok(generic.tags.includes('泛用名降权'))
  assert.equal(normal.tags.length, 0)
})

test('白名单：恢复全权重并打标签（用户要点：业务里的 push 要能提回来）', () => {
  const symbols = [sym('push', { p: 'src/app.rs' }), sym('caller', { p: 'src/other.rs' })]
  const edges = [{ from: 1, to: 0, prov: 'name' }]
  const damped = model(symbols, edges).score(0)
  const listed = model(symbols, edges, { whitelist: ['push'] }).score(0)

  assert.ok(listed.score > damped.score)
  assert.ok(Math.abs(listed.score / damped.score - 1 / DEFAULT_CONFIG.genericDamp) < 1e-9, '提升倍数应为 1/genericDamp')
  assert.ok(listed.tags.includes('白名单'))
  assert.equal(listed.tags.includes('泛用名降权'), false, '白名单后不该再打降权标签')
})

test('泛用名表覆盖用户给定清单（回归护栏）', () => {
  for (const n of ['len', 'push', 'pop', 'is_empty', 'empty', 'kind', 'new', 'from_json', 'to_json', 'json', 'parse',
    'serialize', 'deserialize', 'get', 'set', 'add', 'remove', 'update', 'create', 'delete']) {
    assert.ok(GENERIC_NAMES.has(n), `泛用名表缺 ${n}`)
  }
})



test('归一化入度：同名定义越多，得分越被压（用户要点）', () => {
  const unique = model(
    [sym('alpha', { p: 'src/a.rs' }), sym('c1', { p: 'src/b.rs' })],
    [{ from: 1, to: 0, prov: 'name' }],
  ).score(0)
  const dup = model(
    [sym('alpha', { p: 'src/a.rs' }), sym('alpha', { p: 'src/c.rs' }), sym('c1', { p: 'src/b.rs' })],
    [{ from: 2, to: 0, prov: 'name' }],
  ).score(0)

  assert.equal(unique.amb, 1)
  assert.equal(unique.norm, 1)
  assert.equal(dup.amb, 2)
  assert.equal(dup.norm, 0.5)
  assert.ok(Math.abs(dup.score / unique.score - 0.5) < 1e-12, '同入度下，2 处同名定义恰好压一半')
})



test('同文件引用 ×0.7；测试路径引用 ×testDamp（可叠加）', () => {
  const sameFile = model([sym('f', { p: 'src/a.rs' }), sym('c', { p: 'src/a.rs' })], [{ from: 1, to: 0, prov: 'same-file' }]).score(0)
  const crossFile = model([sym('f', { p: 'src/a.rs' }), sym('c', { p: 'src/b.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  assert.ok(Math.abs(sameFile.win - 0.7) < 1e-12)
  assert.equal(crossFile.win, 1)

  const fromTest = model([sym('f', { p: 'src/a.rs' }), sym('c', { p: 'src/tests/t.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  assert.ok(Math.abs(fromTest.win - DEFAULT_CONFIG.testDamp) < 1e-12)
  assert.equal(fromTest.pw, 1, '目标自身不在测试路径，路径权重不打折')

  const stacked = model([sym('f', { p: 'src/tests/t.rs' }), sym('c', { p: 'src/tests/t.rs' })], [{ from: 1, to: 0, prov: 'same-file' }]).score(0)
  assert.ok(Math.abs(stacked.win - 0.7 * DEFAULT_CONFIG.testDamp) < 1e-12, '同文件 × 测试路径 应叠加')
  assert.equal(stacked.pw, DEFAULT_CONFIG.testDamp, '目标在测试路径 → 路径权重打折')
})

test('类型权重：顶层 var 只有函数的一部分权重', () => {
  const asFn = model([sym('f', { p: 'src/a.rs', t: 'fn' }), sym('c', { p: 'src/b.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  const asVar = model([sym('f', { p: 'src/a.rs', t: 'var' }), sym('c', { p: 'src/b.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  assert.equal(asFn.k, KIND_WEIGHT.fn)
  assert.equal(asVar.k, KIND_WEIGHT.var)
  assert.ok(Math.abs(asVar.score / asFn.score - KIND_WEIGHT.var / KIND_WEIGHT.fn) < 1e-12)
})

test('类型权重：成员类符号（field/prop/variant）显式 0 —— 不靠兜底、也不该进枢纽', () => {
  for (const k of ['field', 'prop', 'variant']) {
    assert.equal(KIND_WEIGHT[k], 0, `${k} 的权重必须显式 0（第四十九轮补入的成员类符号不是枢纽候选）`)
  }

  const s = model(
    [sym('retries', { p: 'src/a.rs', t: 'field' }), sym('caller', { p: 'src/b.rs' })],
    [{ from: 1, to: 0, prov: 'name' }],
  ).score(0)
  assert.equal(s.score, 0)
})

test('跨度系数：单行小工具降权', () => {
  const short = model([sym('f', { p: 'src/a.rs', l: 10, el: 10 }), sym('c', { p: 'src/b.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  const long = model([sym('f', { p: 'src/a.rs', l: 10, el: 20 }), sym('c', { p: 'src/b.rs' })], [{ from: 1, to: 0, prov: 'name' }]).score(0)
  assert.equal(short.span, 1)
  assert.equal(short.sw, 0.7)
  assert.equal(long.sw, 1)
  assert.ok(short.score < long.score)
})

test('跨文件广度：引用方跨文件越多权重越高', () => {
  const build = (n) => {
    const symbols = [sym('f', { p: 'src/a.rs' })]
    const edges = []
    for (let i = 0; i < n; i++) {
      symbols.push(sym(`c${i}`, { p: `src/f${i}.rs` }))
      edges.push({ from: i + 1, to: 0, prov: 'name' })
    }
    return model(symbols, edges).score(0)
  }
  assert.equal(build(1).bw, 0.85)
  assert.equal(build(1).callerFiles, 1)
  assert.equal(build(2).bw, 1)
  assert.equal(build(3).bw, 1.15)
  assert.ok(build(3).score > build(2).score && build(2).score > build(1).score)
})



test('排序确定性：两次 ranking 结果完全一致，同分按名字稳定排序', () => {
  const symbols = [sym('bbb', { p: 'src/a.rs' }), sym('aaa', { p: 'src/a.rs' }), sym('ccc', { p: 'src/z.rs' }), sym('caller', { p: 'src/c.rs' })]
  const edges = [{ from: 3, to: 0, prov: 'name' }, { from: 3, to: 1, prov: 'name' }, { from: 3, to: 2, prov: 'name' }]
  const m = model(symbols, edges)
  const a = m.ranking().map((r) => r.s.n)
  assert.deepEqual(a, m.ranking().map((r) => r.s.n), '必须可复现（确定性）')
  assert.deepEqual(a, ['aaa', 'bbb', 'ccc'], '三者同分 → 按名字升序')
})

test('collapse：同名只留最高分一条，并标注同名定义数', () => {
  const symbols = [sym('dup', { p: 'src/a.rs' }), sym('dup', { p: 'src/b.rs' }), sym('c1', { p: 'src/c.rs' }), sym('c2', { p: 'src/d.rs' })]
  const edges = [
    { from: 2, to: 0, prov: 'name' }, { from: 3, to: 0, prov: 'name' },
    { from: 2, to: 1, prov: 'name' },
  ]
  const m = model(symbols, edges)
  const collapsed = m.collapse(m.ranking())
  assert.equal(collapsed.length, 1)
  assert.equal(collapsed[0].s.n, 'dup')
  assert.equal(collapsed[0].ambCount, 2)
  assert.equal(collapsed[0].i, 0, '应保留得分更高的那处定义')
})

test('ambGroups：同名聚组、按被引用热度排序、标出全 vendor 组', () => {
  const symbols = [
    sym('run', { p: 'src/a.rs' }), sym('run', { p: 'src/b.rs' }),
    sym('map', { p: 'node_modules/x/i.js' }), sym('map', { p: 'node_modules/y/i.js' }),
    sym('solo', { p: 'src/c.rs' }),
  ]
  const m = model(symbols, [])
  const groups = m.ambGroups({ run: 5, map: 40 })
  assert.equal(groups.length, 2, 'solo 是唯一名，不成组')
  assert.deepEqual(groups.map((g) => g.name), ['map', 'run'], '按被引用次数降序')
  assert.equal(groups[0].refs, 40)
  assert.equal(groups[0].vendorOnly, true)
  assert.equal(groups[1].vendorOnly, false)
  assert.equal(groups[1].idxs.length, 2)
  assert.equal(m.ambGroups({}).find((g) => g.name === 'map').refs, 0, '无计数时回落 0 而不是崩')
})

test('ambGroups：组名撞上 Object.prototype 的键（constructor 等）不得读出原型属性', () => {



  const symbols = [sym('constructor', { p: 'a.tsx', t: 'method' }), sym('constructor', { p: 'b.tsx', t: 'method' })]
  const m = model(symbols, [])
  const g = m.ambGroups({}).find((x) => x.name === 'constructor')
  assert.ok(g, 'constructor 组应存在')
  assert.equal(g.refs, 0, '读不到自己的计数时必须是 0，而不是函数/原型属性')
  assert.equal(m.ambGroups({ constructor: 7 }).find((x) => x.name === 'constructor').refs, 7, '自有键正常读取')
})

test('sameNameCount：同名定义计数与缺失名的回落', () => {
  const m = model([sym('x', { p: 'a.rs' }), sym('x', { p: 'b.rs' }), sym('y', { p: 'c.rs' })], [])
  assert.equal(m.sameNameCount('x'), 2)
  assert.equal(m.sameNameCount('y'), 1)
  assert.equal(m.sameNameCount('nope'), 0)
})



test('hubNormTable：log 归一 —— 最高为 1、非枢纽为 0、严格单调', () => {
  const rows = [{ i: 0, score: 288 }, { i: 1, score: 10 }, { i: 2, score: 1 }, { i: 3, score: 0 }]
  const { norm, max } = hubNormTable(rows, 5)
  assert.equal(max, 288)
  assert.equal(norm[0], 1, '最高分归一到 1')
  assert.equal(norm[3], 0, '分数 0 → 0')
  assert.equal(norm[4], 0, '不在榜里的符号也是 0')
  assert.ok(norm[0] > norm[1] && norm[1] > norm[2] && norm[2] > norm[3], '严格单调')

  assert.ok(norm[1] > 0.3, `hub=10/288 应拿到有意义权重，实得 ${norm[1].toFixed(3)}`)
  assert.ok(norm[2] > 0.1, `hub=1/288 也不该被压没，实得 ${norm[2].toFixed(3)}`)
})

test('hubNormTable：全零得分不产生 NaN', () => {
  const { norm, max } = hubNormTable([{ i: 0, score: 0 }], 2)
  assert.equal(max, 0)
  assert.equal(norm[0], 0)
  assert.equal(norm[1], 0)
})
