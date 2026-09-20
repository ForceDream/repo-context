/**
 * repoctx-parallel —— Phase 1（抽取）的**并行执行器**（子进程 CLI）
 *
 * 为什么是子进程：`buildIndex` 及其调用点（index/check/pipeline）是同步代码；若把抽取改成
 * worker_threads 内嵌，buildIndex 必须变 async，会波及全部调用点。子进程方案让主进程用
 * `execFileSync` **同步阻塞**拿结果 —— buildIndex 只加一个 try/fallback 钩子，改动面最小，
 * 确定性不受任何影响（子进程跑的是同一个 `extract`，输出与串行逐字节一致，已对拍验证）。
 *
 * 协议：
 *   node repoctx-parallel.mjs --repo DIR --wasm DIR --files '[{"rel":"a.rs","lang":"rust"},...]'
 *   stdout = {"ok":true,"workers":N,"symbols":{"a.rs":[...]}}   （除此之外不打印任何东西）
 *   任一文件抽取失败 → 该键为 null，主线程对该文件落回行级。
 *
 * 并行结构：本进程把文件**轮转分片**给 N 个 worker_threads（每个 worker 自持一份 WASM parser，
 * 装载互相并行），主线程也亲自跑一个分片；分片失败该部分缺失，主线程按文件回退。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { createAstExtractor } from './repoctx-ast.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function extractChunk(repo, items, wasmDir, dbg) {
  // REPOCTX_DEBUG=1 时把分段计时打到 stderr（stdout 只承载协议 JSON）
  const t0 = Date.now()
  const ast = await createAstExtractor({ wasmDir })
  const t1 = Date.now()
  const out = {}
  let readMs = 0
  let extractMs = 0
  for (const it of items) {
    let text = null
    let a = Date.now()
    try { text = fs.readFileSync(path.join(repo, it.rel), 'utf8') } catch { }
    readMs += Date.now() - a
    if (text == null || !ast.available) { out[it.rel] = null; continue }
    a = Date.now()
    try {
      const syms = ast.extract(it.rel, it.lang, text)
      // ⚠️ 导入绑定挂在数组的**属性**上（`syms.imports`），而 JSON 序列化会丢掉数组属性 ——
      // 所以这里显式转成对象字段传回主进程（实测：不转的话只有串行兜底的那 21 个文件有导入绑定）。
      out[it.rel] = syms && {
        syms,
        imports: syms.imports
          ? { names: syms.imports.names, aliases: [...syms.imports.aliases] }
          : null,
      }
    } catch { out[it.rel] = null }
    extractMs += Date.now() - a
  }
  if (dbg) console.error(`[chunk] items=${items.length} init=${t1 - t0}ms read=${readMs}ms extract=${extractMs}ms`)
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null }
  const repo = get('repo')
  const wasmDir = get('wasm')
  let files = []
  try { files = JSON.parse(get('files') || '[]') } catch { }
  const cpus = (await import('node:os')).cpus?.length || 4
  // 4 个 worker 封顶（2026-09-16 实测扫描 2/3/4/5/6/8：4 最优）。原因：每个 worker 要各自编译
  // ~6MB WASM 语法（init 税 ~0.15s/worker），worker 越多 init 挤兑越重 —— 8 路实测反而比 4 慢。
  // 抽取本身可并行（各 worker extract ≈ 均分），瓶颈在 init。
  const workers = Math.max(1, Math.min(files.length, Number(get('workers') || Math.min(4, cpus - 1))))
  const chunks = Array.from({ length: workers }, () => [])
  files.forEach((f, i) => chunks[i % workers].push(f))   // 轮转：大文件被分散，负载更均匀
  const dbg = process.env.REPOCTX_DEBUG === '1'
  const merged = {}
  const wall0 = Date.now()
  await Promise.all([
    extractChunk(repo, chunks[0], wasmDir, dbg).then((o) => Object.assign(merged, o)),
    ...chunks.slice(1).map((items) => new Promise((resolve) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { repo, items, wasmDir, dbg } })
      w.on('message', (o) => { if (o) Object.assign(merged, o); resolve() })
      w.on('error', () => resolve())                    // 该分片失败 → 主线程对这些文件落回行级
      w.on('exit', (c) => { if (c !== 0) resolve() })
    })),
  ])
  if (dbg) console.error(`[main] workers=${workers} merge 完成于 ${Date.now() - wall0}ms`)
  process.stdout.write(JSON.stringify({ ok: true, workers, files: merged }))
}

if (!isMainThread) {
  // worker 模式：workerData.items 是主进程分好的文件分片
  extractChunk(workerData.repo, workerData.items, workerData.wasmDir, workerData.dbg)
    .then((out) => parentPort.postMessage(out))
    .catch(() => parentPort.postMessage(null))
} else {
  main()
}
