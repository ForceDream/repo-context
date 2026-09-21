# repo-context — a local repository context indexer (pure Node, portable)

> 中文：[README.zh-CN.md](README.zh-CN.md) ｜ Changelog: [CHANGELOG.md](CHANGELOG.md)

> **Pure Node (core has zero dependencies) · offline · cross-platform.** Core features work out of the
> box with **no install**; the optional AST enhancement (tree-sitter wasm, ~49.5 MB) is **not committed**
> — fetch it with `npm install` or the installer's `--with-deps`. Installing it or not never blocks usage.

---

## 0. Three-layer division of labour (measured, read this on large repos)

Measured on a 2.4 GB repository (3,464 files; Rust + TS + Python):

| Task | Tool | Why |
|---|---|---|
| Plain text / regex location | **Your built-in Grep** (ripgrep) | Fastest single shot (~2s); this tool does no text search |
| **Where is it implemented / `callers` / `impact` / `hubs` / `for` / repo notes** | **this tool** | One `index` pass is seconds (measured 3.1s / 367 files / 6,104 symbols / 15,945 edges), then every query is <0.3s; `callers` / `impact` / `hubs` / `for` exist in neither Grep nor [aisearch](https://github.com/ForceDream/ai-search) |
| Reading a function body / line ownership / paging large files | **[aisearch](https://github.com/ForceDream/ai-search)** | `read <file>#<sym>` and `context` are O(single file) — fast and token-efficient |

**In one line**: this tool does **locating and impact analysis** (indexed, instant), aisearch does
**precise reading**, and Grep does **plain text**. Indexing is a one-off cost whose payoff grows with
repeated queries; re-run `index` after code changes and `check` before committing.

---

## 1. What is this

An indexer that builds the chain **source → symbols → relationship graph → deterministic Q&A**:

- Runs with **Node only** (line-level extraction has zero dependencies), **offline**, **cross-platform**;
- Indexes the **local working tree**, including uncommitted changes;
- Answers come from a rebuildable, drift-checkable `.repoctx/map.json` (schema `repoctx/2`; a version
  mismatch **fails loudly**).

---

## 2. Install

### Linux / macOS

```bash
bash install.sh                # install the skill (line-level mode, zero deps)
bash install.sh --with-deps    # additionally npm install for the AST enhancement (more accurate)
bash install.sh --target="$HOME/.agent-skills/repo-context"
```

### Windows

```powershell
.\install.ps1
.\install.ps1 -WithDeps
.\install.ps1 -Target "$env:USERPROFILE\.agent-skills\repo-context"
```

> Default skill directory: `~/.agent-skills/repo-context` (Windows: `%USERPROFILE%\.agent-skills\repo-context`).
> Point `--target=` / `-Target` at the skill directory your agent actually uses.

### Run without installing

```bash
node scripts/repoctx.mjs index
node scripts/repoctx.mjs for "auth token refresh"
node scripts/repoctx.mjs impact <symbol> --depth 3
```

Self-test: `npm test` (Node's built-in test runner, zero dependencies).

---

## 3. Command reference

```text
index [--repo DIR]                      build/rebuild the index (uncommitted changes included)
pipeline [--out DIR]                    five-stage pipeline: per-stage timings + counts; can export views
for "<english keywords>" [--top N]      task-relevant symbols (term frequency + hub-score tiebreak)
symbol NAME | callers NAME | callees NAME | impact NAME [--depth N] [--types]
context NAME                            definition + notes + callers + blast radius + type refs + imports
affected --diff [rev] | --files a.rs,b.ts [--depth N] [--types]   # PR review: seeds + union of impact
impls NAME                              interface/impl both ways (trait→impl / type→trait)
typerefs NAME                           type references, both directions (not part of the call graph)
imports NAME                            which files import this symbol (AST import bindings)
hubs [--top N] [--explain]              hub ranking; --explain prints each scoring factor
amb [NAME]                              ambiguity groups (same name defined >1×; expand a group with NAME)
tree [--top N]
files [--by size|syms|cx|dupes] [--dir PREFIX]   file-level metrics (largest / densest / most complex / same-name)
note --sym NAME --text "..." [--tags a,b]        record knowledge bound to a symbol (or --file PATH)
notes [--sym NAME] [--contains TEXT]
export [--out FILE]                     → .repoctx/MAP.md (human-readable, committable, diffable)
check                                   does the artifact still match the sources? (0 drift; run before commit)
```

> Declaration-layer gap audit: `node scripts/repoctx-decl-audit.mjs --strict`
> PR-review hook: `node scripts/install-hooks.mjs` (idempotent, touches only its managed block, **never blocks a push**); `node scripts/pr-affected.mjs --base origin/HEAD`

**Rules of thumb**: write `for` queries in **English or symbol names** (ranking relies on sub-word
matching — no Chinese tokenisation); conclusions carry `prov` (edge provenance) so they can be verified.

---

## 4. Two extractors

| | Line-level (default, zero deps) | AST / tree-sitter (optional install) |
|---|---|---|
| Dependencies | none | `web-tree-sitter@0.20.8` + `tree-sitter-wasms` (wasm, cross-platform) |
| Identifiers inside comments/strings | stripped | excluded by construction |
| Local variables | approximated by indentation | exact, by column |
| `cx` cyclomatic complexity | approximated | counted from AST decision points |

Without `node_modules`, it **falls back to line-level automatically** — functionality stays complete,
accuracy is slightly lower, nothing fails.

---

## 5. Layout

```
repo-context/
├─ README.md (English) / README.zh-CN.md (Chinese)
├─ install.sh / install.ps1       ← one-shot install (Linux·macOS / Windows)
├─ SKILL.md                       ← the skill itself: verbs / extractors / memory model / honest boundaries
├─ CHANGELOG.md
├─ package.json / package-lock.json
├─ docs/         pipeline · lsp-bridge-evaluation
├─ scripts/      20 .mjs + repoctx.cmd (9 of them tests, run via `npm test`)
└─ node_modules/ optional (tree-sitter wasm via npm install; not committed)
```

---

## 6. Four artifacts = one repository memory

| File | Produced by | Nature | Committed? |
|---|---|---|---|
| `.repoctx/map.json` | `index` | machine facts: derived from sources, rebuildable, no timestamps | no |
| `.repoctx/notes.jsonl` | `note` | human knowledge: append-only, dated, not rebuildable | yes |
| `.repoctx/MAP.md` | `export` | human-readable projection of machine facts + notes | yes |
| `.repoctx/config.json` | human | scoring allow-list and coefficients | yes |

---

## 7. Maintenance notes

1. Re-run `index` after editing code (seconds); run `check` before committing. On mismatch, rebuild —
   **never hand-edit the artifacts**.
2. After changing `scripts/`, **sync to the installed directory** (re-run the installer;
   `node_modules` need not be reinstalled).
3. **Dependency trap**: `web-tree-sitter@0.27` is **incompatible** with `tree-sitter-wasms` (ABI 14) —
   use `0.20.x`; also, `Parser.Language` must be read **after** `Parser.init()`.
4. **Line endings / BOM**: `.sh` uses LF; `.ps1` carries a UTF-8 BOM.
5. Measured numbers in documentation **must carry a date**; re-run the corresponding verb before
   quoting an old figure.

---

## 8. Honest boundaries

- **In-edge results self-report confidence**: `conf="none"` (ambiguous name, references not connected →
  **`n=0` does not mean "unused"**); `conf="low"` (generic name; name-level matching may pull in a
  same-named stdlib call). This is **labelling, not fixing**.
- **`cx` semantics**: branch count **within a symbol's span** (nested definitions included); to judge a
  single function, use `cxOwn` or leaf symbols.
- **`files --by dupes`**: same name ≠ duplicate; it is a lead, not a verdict.
- **Same-name definitions are not connected by default**; they are aggregated into `amb` groups and
  only resolved by rules explainable via `prov`.
- **Not supported**: exact overload/generic disambiguation, cross-language FFI, runtime information.

---

## 9. Versions and origin

- Contents: the repository copy of this tool plus its user-level skill installation.
- Toolchain: Node ≥ 18 (core has zero dependencies; matches `engines` in `package.json`).

## License

MIT
