












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


const qOf = (src, lang, file, name) => ex.extract(file, lang, src)?.find((s) => s.name === name)?.q

test('Rust：嵌套 mod + impl 方法得到 容器链::方法；自由函数不产出 q', { skip }, () => {
  const src = ['pub fn free_one() {}', 'mod inner {', '  pub struct S;', '  impl S { pub fn go(&self) {} }', '}'].join('\n')
  assert.equal(qOf(src, 'rust', 't.rs', 'go'), 'inner::S::go')
  assert.equal(qOf(src, 'rust', 't.rs', 'free_one'), undefined, '无容器 → 不产出 q（省产物体积）')
})

test('TS：类方法与函数内 const 箭头都带容器链', { skip }, () => {
  const src = ['export class Batch {', '  push(e) { return e }', '}', 'export function outer() {', '  const inner = () => 1', '  return inner', '}'].join('\n')
  assert.equal(qOf(src, 'ts', 't.ts', 'push'), 'Batch::push')
  assert.equal(qOf(src, 'ts', 't.ts', 'inner'), 'outer::inner')
  assert.equal(qOf(src, 'ts', 't.ts', 'Batch'), undefined, '顶层 class 无容器')
})

test('import / use 行的标识符不进 refs（边集里不存在 WEAK 引用）', { skip }, () => {
  const ts = [
    'import { neverUsedAnywhere } from "./decoy"',
    'import { used } from "./api"',
    'export function usesIt() { return used() }',
  ].join('\n')
  const tsRefs = ex.extract('t.ts', 'ts', ts).flatMap((s) => s.refs || [])
  assert.ok(!tsRefs.includes('neverUsedAnywhere'), '只在 import 行出现的名字不应进入任何符号的 refs')
  assert.ok(tsRefs.includes('used'), '函数体内真正用到的名字应在 refs 里')

  const rs = ['use crate::decoy::never_used_anywhere;', 'use crate::spill::read_spill;', 'pub fn go() { read_spill(); }'].join('\n')
  const rsRefs = ex.extract('t.rs', 'rust', rs).flatMap((s) => s.refs || [])
  assert.ok(!rsRefs.includes('never_used_anywhere'), 'Rust use 行同理')
  assert.ok(rsRefs.includes('read_spill'), 'Rust 函数体内的调用应在 refs 里')
})
