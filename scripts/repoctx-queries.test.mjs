









import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.env.REPOCTX_TEST_REPO || path.resolve(HERE, '..', '..', '..')
const CLI = path.join(HERE, 'repoctx.mjs')
const MAP = path.join(REPO, '.repoctx', 'map.json')
const skip = fs.existsSync(MAP) ? false : `无索引：${path.relative(process.cwd(), MAP)} 不存在（先跑 repoctx index）`


const QUERIES = [
  ['auth token refresh', 'TokenRefresher'],
  ['mcp proxy tool', 'McpProxyTool'],
  ['intent analyzer classify', 'IntentAnalyzer'],
  ['tool registry office', 'OfficeTool'],
  ['spill text offset limit', 'SpillRef'],
  ['user avatar password profile', 'avatarUrl'],
  ['graph layout node edge', 'pickGraphLayout'],
  ['session context config', 'ContextConfig'],
  ['attachment context chat', 'format_attachment_context'],
  ['db pool connection', 'DbPool'],
]

for (const [q, expect] of QUERIES) {
  test(`for "${q}" → 期望 ${expect} 在 top5`, { skip }, () => {
    const out = execFileSync(process.execPath, [CLI, 'for', q, '--repo', REPO, '--top', '5'], { encoding: 'utf8' })
    assert.ok(out.includes(`n="${expect}"`), `期望 ${expect} 出现在 top5，实际输出：\n${out}`)
  })
}
