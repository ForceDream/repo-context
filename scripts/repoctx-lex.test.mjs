/**
 * 字符级健壮性单测（2026-09-16）
 *
 * 动机：此前测试只覆盖"结构"（限定名、import 不入选），**没覆盖那些会把解析器带偏的字符**——
 * 括号 / 引号 / 转义 / 未闭合串 / 正则字面量 / Rust 生命周期 / 原始字符串。
 * 真实教训：探针脚本少一对花括号导致分桶统计静默错（自校验才抓出来）；
 * 同类"细枝末节"在解析层同样会静默出错。
 *
 * 两层都测：
 *   · AST 模式（tree-sitter）：字符串/注释里的内容**不能**变成符号或引用；
 *   · 行级模式（stripNoise 正则剥离）：原始字符串 / 生命周期 / 正则字面量里的引号都不能吞掉真实代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAstExtractor } from './repoctx-ast.mjs'
import { stripNoise } from './repoctx-hub.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WASM = process.env.REPOCTX_WASM_DIR || path.join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out')
const ex = fs.existsSync(WASM)
  ? await createAstExtractor({ wasmDir: WASM })
  : { available: false, reason: `未安装 AST 增强（${WASM} 不存在）` }
const skip = ex.available ? false : `AST 不可用：${ex.reason}`

const syms = (src, lang, file) => ex.extract(file, lang, src) || []
const namesOf = (src, lang, file) => syms(src, lang, file).map((s) => s.name)
const refsOf = (src, lang, file, name) => (syms(src, lang, file).find((s) => s.name === name) || {}).refs || []

// ── AST 模式：Rust 的括号/引号/生命周期/原始字符串 ───────────────────────────

const RUST_TRICKY = [
  '// 注释：{ } " \' ` 括号引号全都未闭合',
  '/* 块注释 { } " \' */',
  'fn real_one(x: &str) -> usize {',
  '    let raw = r#"原始串里的 "引号" 与 {括号} 和 fake_from_raw()"#;',
  '    let raw2 = r"平凡原始串 { }";',
  '    let ch = \'{\';',
  '    let esc = "a \\" b { }";',
  '    let fake = "fn fake_from_string() { if x { } }";',
  '    x.len() + raw.len() + raw2.len() + esc.len() + (ch as usize) + fake.len()',
  '}',
  "fn with_lifetime<'a>(needle: &'a str) -> &'a str { needle }",
  "struct Holder<'a> { name: &'a str }",
  "impl<'a> Holder<'a> { fn get(&self) -> &'a str { self.name } }",
].join('\n')

test('Rust：字符串/注释里的伪函数不进符号表', { skip }, () => {
  const ns = namesOf(RUST_TRICKY, 'rust', 'tricky.rs')
  assert.ok(ns.includes('real_one'), '真实函数必须抽到')
  assert.ok(ns.includes('with_lifetime'), '带生命周期的函数签名不能把解析带偏')
  assert.ok(ns.includes('Holder') && ns.includes('get'), '带生命周期的 struct/impl 方法必须抽到')
  assert.ok(!ns.includes('fake_from_string'), '字符串里的 `fn fake_from_string()` 不是符号')
  assert.ok(!ns.includes('fake_from_raw'), '原始字符串里的调用不是符号')
})

test('Rust：字符串/注释里的名字不进 refs', { skip }, () => {
  const r = refsOf(RUST_TRICKY, 'rust', 'tricky.rs', 'real_one')
  assert.ok(!r.includes('fake_from_string'), '字符串内容不能进 refs')
  assert.ok(!r.includes('fake_from_raw'), '原始字符串内容不能进 refs')
  assert.ok(!r.includes('虚假'), '注释里的中文也不该进 refs')
})

test('Rust：容器链在带生命周期时依然正确；圈复杂度不被字符串里的 if 抬高', { skip }, () => {
  const all = syms(RUST_TRICKY, 'rust', 'tricky.rs')
  const get = all.find((s) => s.name === 'get')
  assert.equal(get.q, 'Holder::get')
  const real = all.find((s) => s.name === 'real_one')
  assert.equal(real.cx, 1, '字符串里的 `if` 不是决策点 → cx 必须是 1')
})

// ── AST 模式：TS/TSX 的模板串/转义/正则字面量/JSX ────────────────────────────

const TS_TRICKY = [
  '// 注释 { } " \' `',
  'const re = /[{}()"\']+/g',
  'export function tricky(input: string) {',
  '  const tpl = `模板 ${input} " 引号 { 括号 }`',
  '  const esc = "a \\" b"',
  '  const fake = "function fake_from_string() { if (x) { } }"',
  '  return trick2(tpl + esc + re.source + fake)',
  '}',
  'export function trick2(s: string) { return s }',
].join('\n')

test('TS：模板串/转义/正则字面量都不产生幻影符号，且真实调用进 refs', { skip }, () => {
  const all = syms(TS_TRICKY, 'ts', 'tricky.ts')
  const ns = all.map((s) => s.name)
  assert.ok(ns.includes('tricky') && ns.includes('trick2'))
  assert.ok(!ns.includes('fake_from_string'), '字符串里的伪函数不是符号')
  const r = refsOf(TS_TRICKY, 'ts', 'tricky.ts', 'tricky')
  assert.ok(r.includes('trick2'), '真实调用必须进 refs')
  assert.ok(!r.includes('fake_from_string'))
  assert.equal(all.find((s) => s.name === 'tricky').cx, 1, '字符串里的 `if` 不抬高 cx')
})

test('TSX：JSX 属性里的引号/花括号不影响抽取', { skip }, () => {
  const src = 'export function View() { return <div title="a \'b\' {c}" data-x={`{ }`}>x</div> }'
  const ns = namesOf(src, 'tsx', 'v.tsx')
  assert.ok(ns.includes('View'))
  assert.ok(ns.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)), '不得抽出带引号/括号的怪名字：' + ns.join(','))
})

// ── 行级模式：stripNoise 的字符级剥离 ────────────────────────────────────────

test('stripNoise：双引号/单引号/模板串/行注释/块注释内容被剥离，代码保留', () => {
  const src = [
    'let a = "字符串里的 quoted_call()";',
    "let b = '单引号里的 single_call()';",
    'let c = `模板里的 template_call()`;',
    '// 注释里的 commented_call()',
    '/* 块注释里的 blocked_call() */',
    'let d = real_call();',
  ].join('\n')
  const out = stripNoise(src, 'ts')
  for (const gone of ['quoted_call', 'single_call', 'template_call', 'commented_call', 'blocked_call']) {
    assert.ok(!out.includes(gone), `${gone} 应被剥离干净（实际：${out}）`)
  }
  assert.ok(out.includes('real_call'), '真实代码必须原样保留')
})

test('stripNoise：Rust 原始字符串 r#"…#" 也是字符串（内容不泄漏）', () => {
  const src = 'let a = r#"原始串里的 fake_from_raw()"#;\nlet b = r"平凡串 fake_too()";\nlet c = real_call();'
  const out = stripNoise(src, 'rust')
  assert.ok(!out.includes('fake_from_raw'), 'r#"…"# 内容应被剥离')
  assert.ok(!out.includes('fake_too'), 'r"…" 内容应被剥离')
  assert.ok(out.includes('real_call'), '真实代码保留')
})

test('stripNoise：Rust 生命周期 `\'a` 不能被当成字符字面量吃掉代码', () => {
  const src = "fn f<'a>(needle: &'a str) -> &'a str { needle }"
  const out = stripNoise(src, 'rust')
  assert.ok(!out.includes("''"), `不应产生 '' 伪影（吞掉中间代码）：${out}`)
  assert.ok(out.includes('needle'), '参数名不能被吃掉')
  assert.ok(out.includes('&'), '类型标注不能被吃掉')
  // 字符字面量仍要被剥离（Rust 单引号只可能是字符）
  assert.ok(!stripNoise("let c = '{';", 'rust').includes('{'), '字符字面量 `\'{\'` 应被剥离')
})

test('stripNoise：JS 正则字面量里的引号不吞掉后续真实代码', () => {
  // 单行是关键：正则与后续代码同行时，正则里的引号才会"配对"到后面的字符串
  const src = 'const re = /[\"\']/g; const s = real_call(); const t = "x"'
  const out = stripNoise(src, 'ts')
  assert.ok(out.includes('real_call'), `正则里的引号不能开始一个"字符串"把后面吞掉：${out}`)
  assert.ok(out.includes('const t'), '正则之后的代码必须保留')
})

test('stripNoise：除法不被误当正则字面量', () => {
  const out = stripNoise('const x = a / b / c; const y = real_call()', 'ts')
  assert.ok(out.includes('a / b / c'), `除法不应被当成正则：${out}`)
  assert.ok(out.includes('real_call'))
})
