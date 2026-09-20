/**
 * 抽取器全量覆盖测试（2026-09-16）
 *
 * 动机：此前的测试只断言"名字被抽到了"——**没断言种类与字段**（`t`/`l`/`el`/`sig`/`q`/`tr`/`exp`/`cx`/`refs`/`qrefs`），
 * 也没覆盖**每一类声明**（struct/enum/trait/type alias/interface/impl/static/macro/抽象类/枚举…）。
 * 本文件按抽取器的 DECLS 表逐语言枚举：断言每一类的 kind 映射与关键字段；
 * 再对**真实产物**做覆盖断言（每种 kind 都在、每种 edge prov 都在、字段健全）。
 *
 * 三条**实测得出**的行为约定（写测试时踩过，固化成护栏）：
 *   1. **名字长度 < 2 的声明被跳过**（`name.length < 2` 噪声过滤）——所以用例里不能用 `C`/`I`/`m` 这类单字符名；
 *   2. `struct Point` 与 `impl Point` **同名**（impl 的名字取自类型）——按名建 Map 会被覆盖，必须用数组；
 *   3. 语法错误由 tree-sitter 自行恢复：TS 里 ERROR 可能吞掉**后续**声明（Rust 里两个都能抽到）——
 *      容错要求是"不抛异常 + 能抽到多少抽多少"，不是"全都能抽到"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAstExtractor } from './repoctx-ast.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WASM = process.env.REPOCTX_WASM_DIR || path.join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out')
const ex = fs.existsSync(WASM)
  ? await createAstExtractor({ wasmDir: WASM })
  : { available: false, reason: `未安装 AST 增强（${WASM} 不存在）` }
const skip = ex.available ? false : `AST 不可用：${ex.reason}`

const list = (src, lang, file) => ex.extract(file, lang, src) || []
const byName = (src, lang, file) => new Map(list(src, lang, file).map((s) => [s.name, s]))
const kinds = (src, lang, file) => { const m = {}; for (const s of list(src, lang, file)) m[s.name] = s.kind; return m }

// ── Rust：DECLS 全部 11 类 ────────────────────────────────────────────────────

const RUST_ALL = [
  'pub fn top_fn(a: u32) -> u32 { if a > 0 { a } else { 0 } }',
  'fn private_fn() {}',
  'pub struct Point { pub x: i32, y: i32 }',
  'pub enum Color { Red, Green }',
  'pub trait Shape {',
  '    fn area(&self) -> f64;',
  '    fn name(&self) -> String { String::new() }',
  '}',
  'pub mod inner { pub fn nested() {} }',
  'pub const MAX_LIMIT: u32 = 10;',
  'static CACHE_MAP: u32 = 1;',
  'macro_rules! my_macro { () => {}; }',
  'pub type NameAlias = u32;',
  'impl Point { pub fn new_at() -> Point { Point { x: 0, y: 0 } } }',
  'impl Shape for Point { fn area(&self) -> f64 { 0.0 } }',
  'fn with_params(alpha: u32, beta: u32) { let local_x = alpha + beta; let _ = local_x; }',
  'struct One;',
].join('\n')

test('Rust：DECLS 每一类都抽出，且 kind 映射正确', { skip }, () => {
  const all = list(RUST_ALL, 'rust', 'all.rs')
  const k = kinds(RUST_ALL, 'rust', 'all.rs')
  assert.equal(k.top_fn, 'fn')
  assert.equal(k.private_fn, 'fn')
  assert.equal(k.Color, 'enum')
  assert.equal(k.Shape, 'trait')
  assert.equal(k.inner, 'mod')
  assert.equal(k.MAX_LIMIT, 'const')
  assert.equal(k.CACHE_MAP, 'const', 'static_item 映射为 const（不显然的映射，需回归护栏）')
  assert.equal(k.my_macro, 'macro')
  assert.equal(k.NameAlias, 'type')
  assert.equal(k.area, 'fn', 'trait 方法声明（function_signature_item，无函数体）也必须是符号')
  assert.equal(k.name, 'fn', 'trait 默认实现（有体）也是符号')
  assert.equal(k.nested, 'fn')
  assert.equal(k.new_at, 'fn')
  // struct 与 impl 同名：必须用数组断言，Map 会被后者覆盖
  assert.equal(all.filter((s) => s.name === 'Point' && s.kind === 'struct').length, 1)
  assert.equal(all.filter((s) => s.name === 'Point' && s.kind === 'impl').length, 2)
  assert.equal(k.One, 'struct', 'unit struct 也是符号')
})

test('Rust：exp（可见性）逐类正确——pub 与私有', { skip }, () => {
  const all = list(RUST_ALL, 'rust', 'all.rs')
  const pubOf = (n) => all.find((s) => s.name === n && s.kind !== 'impl')?.exp
  for (const n of ['top_fn', 'Point', 'Color', 'Shape', 'inner', 'MAX_LIMIT', 'NameAlias']) {
    assert.equal(pubOf(n), true, `${n} 应为 pub`)
  }
  for (const n of ['private_fn', 'CACHE_MAP', 'my_macro', 'with_params']) {
    assert.equal(pubOf(n), false, `${n} 非 pub`)
  }
})

test('Rust：q（容器链）——顶层无 q、嵌套/成员有链、同名声明各带自己的链', { skip }, () => {
  const b = byName(RUST_ALL, 'rust', 'all.rs')
  assert.equal(b.get('top_fn').q, undefined, '顶层无容器 → 省略 q（省体积）')
  assert.equal(b.get('inner').q, undefined, '顶层 mod 自身无链')
  assert.equal(b.get('nested').q, 'inner::nested')
  assert.equal(b.get('new_at').q, 'Point::new_at')
  // `area` 在两处声明（trait 签名 + impl 实现）——同名不同链，必须用数组断言
  const areaQs = list(RUST_ALL, 'rust', 'all.rs').filter((s) => s.name === 'area').map((s) => s.q).sort()
  assert.deepEqual(areaQs, ['Point::area', 'Shape::area'])
})

test('Rust：impl 的 tr（trait 名）——固有 impl 无、trait impl 有', { skip }, () => {
  const impls = list(RUST_ALL, 'rust', 'all.rs').filter((s) => s.kind === 'impl')
  assert.equal(impls.length, 2, '两个 impl 块都应是符号（名字都取自类型 Point）')
  assert.ok(impls.every((s) => s.name === 'Point'))
  assert.equal(impls.filter((s) => !s.tr).length, 1, '固有 impl 无 tr')
  assert.equal(impls.filter((s) => s.tr === 'Shape').length, 1, '`impl Shape for Point` 的 tr 必须是 Shape')
})

test('Rust：cx（圈复杂度）与 refs（局部名/形参不进引用）', { skip }, () => {
  const b = byName(RUST_ALL, 'rust', 'all.rs')
  assert.equal(b.get('top_fn').cx, 2, '1 + 一个 if_expression')
  assert.equal(b.get('private_fn').cx, 1)
  assert.equal(b.get('with_params').cx, 1, 'let 不是决策点')
  const refs = b.get('with_params').refs
  assert.ok(!refs.includes('local_x'), '函数内局部名不进 refs')
  assert.ok(!refs.includes('alpha') && !refs.includes('beta'), '形参不进 refs')
})

test('Rust：qrefs 收集 scoped 调用（UFCS 消解数据源）', { skip }, () => {
  const src = ['pub struct Holder;', 'impl Holder { pub fn new_at() -> Holder { Holder } }', 'pub fn go() -> Holder { Holder::new_at() }'].join('\n')
  const b = byName(src, 'rust', 'q.rs')
  const qr = b.get('go').qrefs || []
  assert.equal(qr.length, 1, `应收集到 1 条 scoped 调用，实际 ${JSON.stringify(qr)}`)
  assert.equal(qr[0].name, 'new_at')
  assert.equal(qr[0].path, 'Holder')
})

// ── TypeScript：DECLS 全部 10 类 ─────────────────────────────────────────────

const TS_ALL = [
  'export function topFn(a: number) { if (a) { return 1 } return 0 }',
  'function privateFn() {}',
  'export class Batch { pushItem(e) { return e } }',
  'export abstract class Base { abstract go(): void }',
  'export interface Shape { area(): number }',
  'export type NameAlias = string | number',
  'export enum Color { Red, Green }',
  'export const arrowFn = (x: number) => { if (x) { return 1 } return 0 }',
  'const localConstValue = 1',
  'export function* genFn() { yield 1 }',
].join('\n')

test('TS：DECLS 每一类都抽出，且 kind 映射正确（含 enum→type 这条不显然的映射）', { skip }, () => {
  const k = kinds(TS_ALL, 'ts', 'all.ts')
  assert.equal(k.topFn, 'fn')
  assert.equal(k.privateFn, 'fn')
  assert.equal(k.Batch, 'class')
  assert.equal(k.Base, 'class', 'abstract_class_declaration → class')
  assert.equal(k.Shape, 'iface')
  assert.equal(k.NameAlias, 'type')
  assert.equal(k.Color, 'type', 'enum_declaration → type（不显然的映射，需回归护栏）')
  assert.equal(k.arrowFn, 'var')
  assert.equal(k.localConstValue, 'var')
  assert.equal(k.genFn, 'fn', 'generator_function_declaration → fn')
  assert.equal(k.pushItem, 'method')
})

test('TS：exp（export 前缀）与 q（类方法容器链）正确', { skip }, () => {
  const b = byName(TS_ALL, 'ts', 'all.ts')
  for (const n of ['topFn', 'Batch', 'Base', 'Shape', 'NameAlias', 'Color', 'arrowFn', 'genFn']) {
    assert.equal(b.get(n).exp, true, `${n} 应 export`)
  }
  for (const n of ['privateFn', 'localConstValue']) assert.equal(b.get(n).exp, false, `${n} 未 export`)
  assert.equal(b.get('pushItem').q, 'Batch::pushItem')
  assert.equal(b.get('topFn').q, undefined)
})

test('TS：cx 在箭头函数与普通函数上口径一致', { skip }, () => {
  const b = byName(TS_ALL, 'ts', 'all.ts')
  assert.equal(b.get('topFn').cx, 2, '1 + if_statement')
  assert.equal(b.get('arrowFn').cx, 2, '箭头函数体里的 if 同样计入')
})

test('JS：只抽 js DECLS（interface/type/enum 不抽）', { skip }, () => {
  const src = [
    'export function fnOne() {}',
    'export class ClsOne { methodOne() {} }',
    'export const valOne = 1',
  ].join('\n')
  const k = kinds(src, 'js', 'all.js')
  assert.equal(k.fnOne, 'fn')
  assert.equal(k.ClsOne, 'class')
  assert.equal(k.valOne, 'var')
  assert.equal(k.methodOne, 'method')
  // TS-only 构造在 .js 里是语法错误 → 不应产出符号（能抽到多少抽多少，不抛异常）
  const bad = ['export function okFn() {}', 'export interface IfaceOne { a: number }', 'export type TAlias = string', 'export enum EEnum { A }'].join('\n')
  const kb = kinds(bad, 'js', 'bad.js')
  assert.equal(kb.okFn, 'fn', '语法错误前的声明仍应抽到')
  assert.equal(kb.IfaceOne, undefined, 'JS 没有 interface 声明')
  assert.equal(kb.TAlias, undefined, 'JS 没有 type alias')
  assert.equal(kb.EEnum, undefined, 'JS 没有 enum 声明')
})

test('TSX：走 ts 的 DECLS（interface/type 在 tsx 里也能抽）', { skip }, () => {
  const src = [
    'export interface PropsOne { n: number }',
    'export function ViewOne(props: PropsOne) { return <div>{props.n}</div> }',
    'export const CardOne = (p: PropsOne) => <span>{p.n}</span>',
    'export type CardKind = "a" | "b"',
  ].join('\n')
  const k = kinds(src, 'tsx', 'v.tsx')
  assert.equal(k.PropsOne, 'iface')
  assert.equal(k.ViewOne, 'fn')
  assert.equal(k.CardOne, 'var')
  assert.equal(k.CardKind, 'type')
})

// ── 第四十九轮补齐：字段/变体/成员/泛型参数 + 类型引用 + 导入绑定 ──────────────

test('Rust：字段 / 枚举变体 / 泛型参数都抽出（声明层补齐）', { skip }, () => {
  const src = [
    'pub struct Cfg { pub retries: u32, name: String }',
    'pub enum Color { Red, Green }',
    'pub fn build<T>(x: T) -> Cfg { Cfg { retries: 1, name: String::new() } }',
    'impl<T: Clone> Cfg { pub fn dup(x: T) -> T { x } }',
  ].join('\n')
  const b = byName(src, 'rust', 'f.rs')
  const k = kinds(src, 'rust', 'f.rs')
  assert.equal(k.retries, 'field')
  assert.equal(k.name, 'field')
  assert.equal(k.Red, 'variant')
  assert.equal(k.Green, 'variant')
  assert.equal(k.T, 'type', '泛型参数抽成 type kind（值位置引用仍可解析到它）')
  assert.equal(b.get('retries').q, 'Cfg::retries', '字段带容器链')
  assert.equal(b.get('Red').q, 'Color::Red', '变体带容器链')
  assert.equal(b.get('T').local, true, '泛型参数抽出即局部（不进枢纽：T/U/K 撞名必然一大堆）')
})

test('TS：接口属性成员 / 类字段 / 泛型参数抽出', { skip }, () => {
  const src = [
    'export interface Cfg { retries: number; readonly name: string }',
    'export class Holder<T> { value: T | null = null }',
  ].join('\n')
  const k = kinds(src, 'ts', 'f.ts')
  assert.equal(k.retries, 'prop', '接口成员是 prop（不是 type）')
  assert.equal(k.name, 'prop')
  assert.equal(k.value, 'field', '类字段是 field')
  assert.equal(k.T, 'type')
  const b = byName(src, 'ts', 'f.ts')
  assert.equal(b.get('retries').q, 'Cfg::retries')
  assert.equal(b.get('value').q, 'Holder::value')
})

test('类型引用（trefs）：类型位的名字进 trefs、**不再进 refs**（拆族护栏）', { skip }, () => {
  const src = [
    'pub struct Cfg { pub retries: u32 }',
    'pub fn load(cfg: &Cfg) -> Vec<u8> { let x: Cfg = cfg; consume_thing(x) }',
  ].join('\n')
  const b = byName(src, 'rust', 't.rs')
  const load = b.get('load')
  assert.ok((load.trefs || []).includes('Cfg'), `参数/局部类型应进 trefs：${JSON.stringify(load.trefs)}`)
  assert.ok((load.trefs || []).includes('Vec'), `返回类型应进 trefs：${JSON.stringify(load.trefs)}`)
  assert.ok(!(load.refs || []).includes('Cfg'), '类型名不得再进 refs——否则会在调用图里伪造 Cfg 的"调用"边')
  assert.ok(!(load.refs || []).includes('Vec'), '同前')
  assert.ok((load.refs || []).includes('consume_thing'), '真值引用照常进 refs')
})

test('导入绑定（AST 版）：别名 + 无别名导入的原始名清单（依赖面数据源）', { skip }, () => {
  const tsSrc = [
    "import React, { useState as useStateAlias, useEffect } from 'react'",
    'export function useIt() { return useStateAlias(0) + useEffect }',
  ].join('\n')
  const imp = list(tsSrc, 'ts', 'i.ts').imports
  assert.ok(imp, 'AST 抽取应挂载 imports')
  assert.deepEqual(imp.names.slice().sort(), ['React', 'useEffect', 'useState'])
  assert.equal(imp.aliases.get('useStateAlias'), 'useState', '别名映射 local→original')
  const rsSrc = [
    'use crate::models::{User, Account as Acct};',
    'use std::collections::HashMap;',
    'pub fn go() -> u32 { 1 }',
  ].join('\n')
  const imp2 = list(rsSrc, 'rust', 'i.rs').imports
  for (const n of ['User', 'Account', 'HashMap']) assert.ok(imp2.names.includes(n), `应导入 ${n}：${imp2.names}`)
  assert.equal(imp2.aliases.get('Acct'), 'Account')
  assert.ok(!imp2.names.includes('models') && !imp2.names.includes('collections'), '路径前缀不是导入名')
  assert.ok(!imp2.names.includes('std'), 'std 等根段不算导入名')
})

// ── 特殊行为：单字符名、语法错误容错 ─────────────────────────────────────────

test('单字符名被跳过（< 2 字符噪声过滤）', { skip }, () => {
  const src = ['export function f() {}', 'export interface I { a: number }', 'const v = 1'].join('\n')
  const got = list(src, 'ts', 'short.ts').map((s) => s.name)
  assert.ok(!got.includes('f') && !got.includes('I') && !got.includes('v'), `1 字符名不应成为符号：${got.join(',')}`)
})

test('解构声明与多 declarator 的行为（实测约定，非缺口）', { skip }, () => {
  // 解构：`const { a, b } = obj` 不产符号——这些名字本就是**函数内局部名**（FIELD_DECL_NODES 已把它们
  // 从 refs 里排除），不进枢纽、不产生跨文件边是正确的。
  // 仓库实测（2026-09-16）：解构声明 228 处，其中**顶层 0 处** → 不产符号无实际损失。
  assert.deepEqual(list('const { alphaProp, betaProp } = objThing', 'ts', 'd1.ts').map((s) => s.name), [])
  assert.deepEqual(list('const [firstItem, secondItem] = arrThing', 'ts', 'd2.ts').map((s) => s.name), [])
  // 多 declarator：只产首个（nameOf 取第一个 declarator）——已知小缺口，仓库实测仅 6 处此类行且多为函数内
  assert.deepEqual(list('const alphaOne = 1, betaTwo = 2', 'ts', 'd3.ts').map((s) => s.name), ['alphaOne'])
})

test('语法错误容错：不抛异常，能抽到多少抽多少', { skip }, () => {
  // TS：ERROR 会吞掉后续声明（tree-sitter 的恢复行为，不是我们的 bug）
  const tsSrc = ['export function goodOne() {}', 'export const broken = )(', 'export function maybeTwo() {}'].join('\n')
  let tsOut
  assert.doesNotThrow(() => { tsOut = list(tsSrc, 'ts', 'bad.ts') })
  assert.ok(tsOut.some((s) => s.name === 'goodOne'), '错误之前的声明必须抽到')
  // Rust：同样的错误之后，两个函数都能抽到
  const rsSrc = ['fn good_one() {}', '@@@', 'fn good_two() {}'].join('\n')
  let rsOut
  assert.doesNotThrow(() => { rsOut = list(rsSrc, 'rust', 'bad.rs') })
  assert.ok(rsOut.filter((s) => s.kind === 'fn').length >= 1, '至少抽到错误之前的函数')
})

// ── 字段级不变量（所有语言）────────────────────────────────────────────────

test('字段不变量：l/el/sig/kind/exp/refs/cx 逐符号健全', { skip }, () => {
  const KNOWN = new Set(['fn', 'method', 'class', 'iface', 'struct', 'enum', 'trait', 'type', 'mod', 'var', 'const', 'macro', 'impl', 'field', 'variant', 'prop'])
  for (const [src, lang, file] of [[RUST_ALL, 'rust', 'all.rs'], [TS_ALL, 'ts', 'all.ts']]) {
    for (const s of list(src, lang, file)) {
      assert.ok(KNOWN.has(s.kind), `未知 kind ${s.kind}（${s.name}）`)
      assert.ok(Number.isInteger(s.line) && s.line >= 1, `非法行号 ${s.name}`)
      assert.ok(Number.isInteger(s.endLine) && s.endLine >= s.line, `endLine < line：${s.name}`)
      assert.ok(Number.isInteger(s.ind) && s.ind >= 0, `非法列号：${s.name}`)
      assert.ok(typeof s.sig === 'string' && s.sig.length > 0, `缺 sig：${s.name}`)
      assert.equal(s.sig, s.sig.trim(), `sig 未 trim：${JSON.stringify(s.sig)}`)
      assert.ok(Array.isArray(s.refs), `refs 必须是数组：${s.name}`)
      assert.ok(s.exp === true || s.exp === false, `exp 必须是布尔（AST 模式）：${s.name}=${s.exp}`)
      assert.ok(Number.isInteger(s.cx) && s.cx >= 1, `非法 cx：${s.name}=${s.cx}`)
      assert.ok(s.name.length >= 2, `符号名应 ≥2 字符：${JSON.stringify(s.name)}`)
    }
  }
})

// ── 真实产物：种类覆盖 + 边类型（prov）覆盖 + 字段健全 ──────────────────────

const CANDIDATES = [process.env.REPOCTX_TEST_REPO, path.resolve(HERE, '..', '..', '..')].filter(Boolean)
const MAP_FILE = CANDIDATES.map((r) => path.join(r, '.repoctx', 'map.json')).find((p) => fs.existsSync(p))
const mapSkip = MAP_FILE ? false : '无索引产物（先跑 repoctx index）'
const map = MAP_FILE ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : null

test('产物：每种 kind 都在本仓库出现过（抽取覆盖无死角）', { skip: mapSkip }, () => {
  const present = new Set(map.symbols.map((s) => s.t))
  // 注：macro 不在列表里——本仓库**没有 macro_rules!**（实测 0 处），故不要求它出现
  for (const k of ['fn', 'struct', 'enum', 'trait', 'type', 'impl', 'mod', 'const', 'class', 'iface', 'method', 'var', 'sec']) {
    assert.ok(present.has(k), `本仓库应出现过 kind=${k}（实际：${[...present].sort().join(',')}）`)
  }
})

test('产物：每种 edge prov 都在本仓库出现过（消解机制全覆盖）', { skip: mapSkip }, () => {
  const provs = new Set(map.edges.map((e) => e.prov))
  for (const p of ['name', 'same-file', 'doc', 'qname', 'lexical', 'visibility', 'alias', 'scope-unique']) {
    assert.ok(provs.has(p), `应出现过 prov=${p}（实际：${[...provs].sort().join(',')}）`)
  }
})

test('产物：字段健全（q 必含 ::、tr 为简单名、local 仅局部类 kind、exp 有则布尔）', { skip: mapSkip }, () => {
  for (const s of map.symbols) {
    if (s.q !== undefined) assert.ok(s.q.includes('::'), `q 非空时必须含容器链分隔符：${s.n}=${s.q}`)
    if (s.tr !== undefined) assert.match(s.tr, /^[A-Za-z_$][\w$]*$/, `tr 必须是简单名：${s.tr}`)
    // local = 函数体内 var/const **或**抽取器标注的容器内局部名（泛型参数/关联类型绑定，kind=type）
    // ——第四十九轮扩展：type_parameter 等抽出即局部（`T`/`U` 撞名必然一大堆，不能进枢纽）
    if (s.local === true) {
      assert.ok(s.t === 'var' || s.t === 'const' || s.t === 'type', `local 只能标在 var/const/type(泛型参数) 上：${s.n}=${s.t}`)
    }
    if (s.exp !== undefined) assert.ok(typeof s.exp === 'boolean', `exp 只能是布尔：${s.n}`)
  }
})
