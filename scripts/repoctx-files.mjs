/**
 * 仓库文件选择层（**索引与审计共用**，2026-09-16 抽出为独立模块）
 *
 * 为什么必须共用：声明层普查一开始自己走了一遍目录，得到 **2472 个源文件**，而索引实际只吃了
 * **330 个**——差别来自 `git ls-files`（天然尊重 .gitignore）与 `SKIP_DIR`（挡住 `archive/`、
 * `target/`、`node_modules/`）。两边不一致的后果不是"少看几个文件"，而是**审计结论完全失真**：
 * 缺口清单会被废弃代码/归档目录的形态淹没（首跑时 `property_identifier` 12.8 万次这类噪声占满榜首）。
 *
 * 因此：文件选择只允许有**一处真理**，谁要用谁 import。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const LANG_BY_EXT = {
  '.rs': 'rust', '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.jsx': 'jsx', '.py': 'py', '.md': 'md', '.markdown': 'md',
}
export const INDEXED_EXT = new Set(Object.keys(LANG_BY_EXT))
/** 大目录/产物目录：即使没被 gitignore 也要挡住（否则索引退化成爬 target/） */
export const SKIP_DIR = /(^|\/)(node_modules|target|dist|build|\.git|\.repoctx|archive)(\/|$)/
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const posix = (p) => p.split(path.sep).join('/')

let _gitResolved
/**
 * 解析 git 可执行文件。**这一步不能省**：git 不在 PATH 上是常态（本机只有 PortableGit），
 * 而探测失败后是**静默返回 null** → 索引退化成全目录遍历 → 丢掉 .gitignore 过滤与 churn。
 * 实测代价：文件数 416 → 1968、churn 全空、rank 全 0。（"静默退化"是最危险的一类缺陷。）
 */
export function resolveGit() {
  if (_gitResolved !== undefined) return _gitResolved
  const probe = (c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c } catch { return null } }
  _gitResolved = probe('git')
  if (!_gitResolved) {
    const roots = [
      'C:/Program Files (x86)/Git',
      'C:/Program Files/Git',
    ]
    for (const root of roots) {
      let dirs = []
      try { dirs = fs.readdirSync(root).sort().reverse() } catch { continue }
      for (const d of dirs) {
        for (const rel of ['cmd/git.exe', 'bin/git.exe']) {
          const p = path.join(root, d, rel)
          if (fs.existsSync(p) && probe(p)) return (_gitResolved = p)
        }
      }
    }
  }
  return _gitResolved
}

/** 仓库文件清单：优先 git ls-files（天然尊重 .gitignore），退化为目录遍历。返回 posix 相对路径。 */
export function listSourceFiles(repo, { gitBin = resolveGit() } = {}) {
  if (gitBin) {
    try {
      const tracked = execFileSync(gitBin, ['ls-files', '-z'], {
        cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
      return tracked.split('\0').filter(Boolean).map(posix).filter((f) => !SKIP_DIR.test(f))
    } catch { /* 非 git 目录/无 git：落到目录遍历 */ }
  }
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = posix(path.join(dir, e.name))
      if (SKIP_DIR.test(rel)) continue
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk('.')
  return out.sort()
}
