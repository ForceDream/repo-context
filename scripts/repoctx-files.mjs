









import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const LANG_BY_EXT = {
  '.rs': 'rust', '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.jsx': 'jsx', '.py': 'py', '.md': 'md', '.markdown': 'md',
}
export const INDEXED_EXT = new Set(Object.keys(LANG_BY_EXT))

export const SKIP_DIR = /(^|\/)(node_modules|target|dist|build|\.git|\.repoctx|archive)(\/|$)/
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const posix = (p) => p.split(path.sep).join('/')

let _gitResolved





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


export function listSourceFiles(repo, { gitBin = resolveGit() } = {}) {
  if (gitBin) {
    try {
      const tracked = execFileSync(gitBin, ['ls-files', '-z'], {
        cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
      return tracked.split('\0').filter(Boolean).map(posix).filter((f) => !SKIP_DIR.test(f))
    } catch {  }
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
