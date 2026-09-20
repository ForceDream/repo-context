/**
 * PR 复核链路测试（2026-09-16 审核 P3 收口）：`install-hooks.mjs` + `pr-affected.mjs`
 *
 * 这两个脚本此前**无任何测试**（154 行，且是"挂在推送路径上"的东西）——而本项目刚在 `pipeline` 上吃过
 * "没测试的代码会静默漂移"的教训。本文件按可测性分层，**尽量不依赖真 git**：
 *
 *   · `install-hooks` 只检查 `.git` 目录**是否存在** → 用空 `.git` 目录即可确定性地测
 *     （幂等 / 只动托管块 / 保留既有内容 / 卸载 / 永不阻断推送）；
 *   · `pr-affected --files` 模式**不走 git**（直接给文件）→ 只需要一个能被索引的小仓库；
 *   · 只有 `--base`（merge-base 语义）需要真 git → 用仓库自带 `resolveGit()` 解析，拿不到就 skip。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGit } from './repoctx-files.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = path.join(HERE, 'install-hooks.mjs')
const PR = path.join(HERE, 'pr-affected.mjs')
const GIT = resolveGit()
const gitSkip = GIT ? false : '本机无 git（resolveGit 返回 null）'

const run = (script, args, cwd) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, maxBuffer: 32 * 1024 * 1024 }) }
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const tmpRepo = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repoctx-${tag}-`))
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
  return root
}

// ── install-hooks ────────────────────────────────────────────────────────────

test('install-hooks：安装托管块（标记 / node 兜底 / exit 0 永不阻断）', () => {
  const root = tmpRepo('hook')
  try {
    const r = run(INSTALL, ['--repo', root])
    assert.equal(r.code, 0, r.out)
    const hook = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-push'), 'utf8')
    assert.ok(hook.startsWith('#!/bin/sh'), 'hook 必须有 sh shebang')
    assert.ok(hook.includes('# >>> repo-context (managed block) >>>'), '缺开始标记')
    assert.ok(hook.includes('# <<< repo-context (managed block) <<<'), '缺结束标记')
    assert.ok(hook.includes('pr-affected.mjs'), 'hook 必须调用复核脚本')
    assert.ok(hook.includes(process.execPath.replace(/\\/g, '/')), '缺 node 绝对路径兜底（本机 node 不在 PATH 上）')
    // 永不阻断推送：调用失败要吞掉，且脚本以 exit 0 收尾
    const block = hook.slice(hook.indexOf('# >>> repo-context'))
    assert.ok(block.includes('|| true'), '调用失败必须吞掉（|| true）')
    assert.ok(/^exit 0$/m.test(block), '托管块必须以 exit 0 收尾（信息不是门禁）')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('install-hooks：幂等（重复安装逐字节一致）', () => {
  const root = tmpRepo('idem')
  try {
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    const first = fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-push'), 'utf8')
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    assert.equal(fs.readFileSync(path.join(root, '.git', 'hooks', 'pre-push'), 'utf8'), first, '重复安装必须字节一致')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('install-hooks：只动托管块——既有 hook 内容原样保留（含 shebang 与自定义逻辑）', () => {
  const root = tmpRepo('keep')
  try {
    const hookFile = path.join(root, '.git', 'hooks', 'pre-push')
    const mine = '#!/bin/sh\n# 我自己的检查\necho "my check"\n'
    fs.writeFileSync(hookFile, mine, 'utf8')
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    const after = fs.readFileSync(hookFile, 'utf8')
    assert.ok(after.includes('echo "my check"'), `既有内容必须保留：${after}`)
    assert.equal((after.match(/# >>> repo-context \(managed block\) >>>/g) || []).length, 1, '托管块只能有一份')
    // 再装一次（模拟用户升级脚本）：自定义内容仍在，托管块仍只有一份
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    const again = fs.readFileSync(hookFile, 'utf8')
    assert.ok(again.includes('echo "my check"'))
    assert.equal((again.match(/repo-context \(managed block\)/g) || []).length, 2, '标记一进一出共 2 处')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('install-hooks --uninstall：移除托管块；只剩托管块时删文件', () => {
  const root = tmpRepo('uninst')
  try {
    const hookFile = path.join(root, '.git', 'hooks', 'pre-push')
    // ① 只有托管块 → 卸载后文件应被删掉
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    const r1 = run(INSTALL, ['--repo', root, '--uninstall'])
    assert.equal(r1.code, 0, r1.out)
    assert.ok(!fs.existsSync(hookFile), '只剩托管块时卸载应删除文件')
    // ② 有自定义内容 → 卸载后保留内容，文件仍在
    fs.writeFileSync(hookFile, '#!/bin/sh\necho keep-me\n', 'utf8')
    assert.equal(run(INSTALL, ['--repo', root]).code, 0)
    assert.equal(run(INSTALL, ['--repo', root, '--uninstall']).code, 0)
    const after = fs.readFileSync(hookFile, 'utf8')
    assert.ok(after.includes('echo keep-me'), `卸载不得动非托管内容：${after}`)
    assert.ok(!after.includes('repo-context (managed block)'), '托管块应被清除')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// ── pr-affected ──────────────────────────────────────────────────────────────

/**
 * 一个可被索引的小仓库（`--files` 模式不走 git）。
 * ⚠️ **刻意不建 `.git`**：这正是 bug A 的回归场景——没有 `.git` 时 `pr-affected` 必须用 **cwd** 当仓库根，
 * 而不是一路上溯到盘根（原实现会把 `C:\` 当仓库根，进而索引整个盘 → `EPERM: scandir 'C:\$Recycle.Bin'`）。
 */
function fixtureRepo(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `repoctx-pr-${tag}-`))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.rs'), 'pub fn helper() -> u32 { 1 }\n', 'utf8')
  fs.writeFileSync(path.join(root, 'src', 'b.rs'), 'pub fn entry() -> u32 { helper() }\n', 'utf8')
  return root
}

test('pr-affected --files：输出可贴进 PR 的 Markdown（含计数与原始输出块）', () => {
  const root = fixtureRepo('files')
  try {
    const r = run(PR, ['--files', 'src/a.rs'], root)
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.includes('### 改动波及面'), `缺标题：${r.out}`)
    assert.ok(/改动文件 1 个 · 涉及符号（seed）\d+ 个 · \*\*受影响符号 \d+ 个\*\*/.test(r.out), `缺计数行：${r.out}`)
    assert.ok(r.out.includes('<details><summary>原始输出（可复核）</summary>'), '必须附原始输出（可复核）')
    // a.rs 定义 helper，b.rs 的 entry 调用它 → 受影响集合里必须出现 entry
    assert.ok(r.out.includes('entry'), `受影响符号应含 entry：${r.out}`)
    // bug A 的回归断言：没有 .git 时必须用 cwd 当仓库根——若上溯到盘根，这里会出现盘根的扫描错误/空种子
    assert.ok(!/Recycle|EPERM|scandir/i.test(r.out), `不得上溯到盘根去索引：${r.out}`)
    assert.ok(!new RegExp(String.raw`改动文件 0 个`).test(r.out), `改动文件必须被识别（种子不能为空）：${r.out}`)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('pr-affected --out：写成文件并报字节数', () => {
  const root = fixtureRepo('out')
  try {
    const r = run(PR, ['--files', 'src/a.rs', '--out', 'affected.md'], root)
    assert.equal(r.code, 0, r.out)
    assert.ok(/已写入 affected\.md（\d+ 字节）/.test(r.out), r.out)
    const md = fs.readFileSync(path.join(root, 'affected.md'), 'utf8')
    assert.ok(md.includes('### 改动波及面'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('pr-affected --base：merge-base 语义（真 git，缺 git 则跳过）', { skip: gitSkip }, () => {
  const root = fixtureRepo('base')
  const g = (...args) => execFileSync(GIT, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const commit = (msg) => g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', msg)
  try {
    g('init', '-q', '-b', 'main')
    g('add', '-A')
    commit('init')
    g('checkout', '-q', '-b', 'feature')
    fs.writeFileSync(path.join(root, 'src', 'a.rs'), 'pub fn helper() -> u32 { 2 }\n', 'utf8')
    g('add', '-A')
    commit('change helper')
    const r = run(PR, ['--base', 'main'], root)
    assert.equal(r.code, 0, r.out)
    assert.ok(/改动文件 1 个/.test(r.out), `merge-base 应识别出 1 个改动文件：${r.out}`)
    assert.ok(r.out.includes('merge-base'), `应记录 merge-base 基准 sha：${r.out}`)
    assert.ok(r.out.includes('helper'), '受影响集合应含被改动的符号')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
