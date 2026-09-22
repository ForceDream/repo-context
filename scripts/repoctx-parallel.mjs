















import fs from 'node:fs'
import path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { createAstExtractor } from './repoctx-ast.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function extractChunk(repo, items, wasmDir, dbg) {

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



  const workers = Math.max(1, Math.min(files.length, Number(get('workers') || Math.min(4, cpus - 1))))
  const chunks = Array.from({ length: workers }, () => [])
  files.forEach((f, i) => chunks[i % workers].push(f))
  const dbg = process.env.REPOCTX_DEBUG === '1'
  const merged = {}
  const wall0 = Date.now()
  await Promise.all([
    extractChunk(repo, chunks[0], wasmDir, dbg).then((o) => Object.assign(merged, o)),
    ...chunks.slice(1).map((items) => new Promise((resolve) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { repo, items, wasmDir, dbg } })
      w.on('message', (o) => { if (o) Object.assign(merged, o); resolve() })
      w.on('error', () => resolve())
      w.on('exit', (c) => { if (c !== 0) resolve() })
    })),
  ])
  if (dbg) console.error(`[main] workers=${workers} merge 完成于 ${Date.now() - wall0}ms`)
  process.stdout.write(JSON.stringify({ ok: true, workers, files: merged }))
}

if (!isMainThread) {

  extractChunk(workerData.repo, workerData.items, workerData.wasmDir, workerData.dbg)
    .then((out) => parentPort.postMessage(out))
    .catch(() => parentPort.postMessage(null))
} else {
  main()
}
