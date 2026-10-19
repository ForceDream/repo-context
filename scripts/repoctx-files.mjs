
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const LANG_BY_EXT = {
  '.rs': 'rust', '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js',
  '.jsx': 'jsx', '.py': 'py', '.md': 'md', '.markdown': 'md',
}
export const INDEXED_EXT = new Set(Object.keys(LANG_BY_EXT))

export const SKIP_DIR = new RegExp(
  '(^|/)(' + [
    '\\.git', '\\.hg', '\\.svn', '\\.repoctx', '\\.idea', '\\.vscode', '\\.cache',
    'node_modules', 'bower_components', 'jspm_packages', '\\.pnpm-store', '\\.yarn',
    'vendor', 'third[-_]party', 'deps', 'site-packages',
    'target', 'dist', 'build', 'out', 'output', 'outputs', 'coverage',
    '\\.next', '\\.nuxt', '\\.svelte-kit', '\\.turbo', '\\.parcel-cache', '\\.gradle',
    'Pods', 'DerivedData',
    '\\.venv', 'venv', '__pycache__', '\\.tox', '\\.mypy_cache', '\\.pytest_cache', '\\.ruff_cache',
    'archive', 'archives', '\\.agents', '\\.claude', '\\.cursor', 'tmp', 'logs',
  ].join('|') + ')(/|$)', 'i',
)
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export const posix = (p) => p.split(path.sep).join('/')


export const SKIP_DIRS_KEY = 'skipDirs'


export function loadSkipDirs(repo) {
  try {
    const file = path.join(repo, '.repoctx', 'config.json')
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = raw && raw[SKIP_DIRS_KEY]
    return Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : []
  } catch {
    return []
  }
}


export function makeSkipTest(extraDirs = []) {
  const names = new Set()
  const dirs = []
  const globs = []
  for (const raw of extraDirs) {
    const v = posix(String(raw)).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
    if (!v) continue
    if (v.includes('*')) {
      const rx = '^' + v.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '(/|$)'
      globs.push(new RegExp(rx))
    } else if (v.includes('/')) dirs.push(v)
    else names.add(v)
  }
  if (!names.size && !dirs.length && !globs.length) return (rel) => SKIP_DIR.test(rel)
  return (rel) => {
    if (SKIP_DIR.test(rel)) return true
    if (names.size) for (const seg of rel.split('/')) if (names.has(seg)) return true
    for (const d of dirs) if (rel === d || rel.startsWith(d + '/')) return true
    for (const g of globs) if (g.test(rel)) return true
    return false
  }
}

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


export function listSourceFiles(repo, { gitBin = resolveGit(), extraSkip = [] } = {}) {
  const skip = makeSkipTest(extraSkip)
  if (gitBin) {
    try {
      const list = (args) => execFileSync(gitBin, args, {
        cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).split('\0').filter(Boolean).map(posix)
      const tracked = list(['ls-files', '-z'])
      const untracked = list(['ls-files', '--others', '--exclude-standard', '-z'])
      return [...tracked, ...untracked].filter((f) => !skip(f))
    } catch {  }
  }
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      const rel = posix(path.join(dir, e.name))
      if (skip(rel)) continue
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk('.')
  return out.sort()
}
