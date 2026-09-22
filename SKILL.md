---
name: repo-context
name_en: repo-context - Repository Index and Q&A
name_zh: repo-context 仓库索引问答
description: Deterministic local repository indexing and question answering using only Node 18 or newer. Answers where a feature or symbol is implemented, who calls it, what a change would affect, which files to read first, and which are hub files; persists conclusions as traceable repository notes. Use for navigating large or unfamiliar codebases and pre-change impact assessment; zero dependencies, offline, cross-platform, indexes the local working tree including uncommitted changes, every edge carries a reviewable provenance.
description_en: Deterministic local repository indexing and question answering using only Node 18 or newer. Answers where a feature or symbol is implemented, who calls it, what a change would affect, which files to read first, and which are hub files; persists conclusions as traceable repository notes. Use for navigating large or unfamiliar codebases and pre-change impact assessment; zero dependencies, offline, cross-platform, indexes the local working tree including uncommitted changes, every edge carries a reviewable provenance.
description_zh: 本地确定性仓库索引与问答（只需 Node ≥ 18）。回答：某功能或符号在哪实现、谁调用它、改它会波及哪些代码、这个仓库该先读什么、哪些是枢纽文件；并把结论沉淀成可追溯的仓库笔记。适用于大型或陌生代码库的导航与改动前评估；零依赖、离线、跨平台，索引本地工作树（含未提交改动），每条边都带来源可复核。触发词：在哪实现、谁调用、改动影响面、爆炸半径、仓库地图、热点文件、阅读顺序。
argument-hint: Point at a repository and ask who calls it, where it is implemented, or what a change would affect
argument-hint-en: Point at a repository and ask who calls it, where it is implemented, or what a change would affect
argument-hint-zh: 指定仓库，询问某符号在哪实现、谁调用它、改动影响面
user-invocable: true
---

# repo-context

把「源码 → 符号 → 关系图」索引成一份可重建的机器产物（`.repoctx/map.json`），再用固定动词做**确定性**问答：同样的输入给同样的输出，可做 0 漂移校验。

## 定位：附加证据，不是权威

> 本工具是**名字级浅索引**，输出是**附加证据**：任何结论（调用者、影响面、边界）在用于改动决策前，必须对照 checkout 的真实源码复核。文件/符号存在只证明"检索种子有效"，**不证明行为存在，更不证明有测试覆盖**。需要类型级精度（重载消歧、重命名重构）时用真正的 LSP/编译器工具；本工具不可用时报告不可用，不要用编造的命令替代。

## 什么时候用我（触发词）

**触发词**：在哪实现 / 谁调用它 / 改它会波及哪些代码 / 爆炸半径 / 仓库地图 / 枢纽文件 / 阅读顺序 / 这个仓库的既有经验。

**最短上手**（两条命令，把 `--repo` 换成目标仓库）：

```bash
node "<SKILL_DIR>/scripts/repoctx.mjs" index --repo .
node "<SKILL_DIR>/scripts/repoctx.mjs" symbol <符号名> --repo .
```

**只装 Node ≥ 18 就能用全部动词**（零依赖、离线、不联网）；AST 抽取器是**可选增强**，装了更准，不装自动落回行级、不会失败。

不用我：需要真实类型推断或重命名重构 → 用真正的 LSP；只要"整库出现次数"这种无结构统计 → 用 `rg`。

## 调用

`<SKILL_DIR>` 表示本 `SKILL.md` 所在目录的绝对路径；加载技能时系统会给出该技能的 Base directory，将其代入即可。

```bash
node "<SKILL_DIR>/scripts/repoctx.mjs" <动词> [参数] --repo <目标仓库>
```

Windows 若看到随附的 `repoctx.cmd`，可直接调用（自动定位 node）；没有该文件时用上面的 `node` 命令即可。`--repo` 省略时以当前工作目录为仓库根。

**问答前先保证索引新鲜**：首次或源码改动后跑 `index`（秒级）；结论可疑或提交前跑 `check`。不一致就重建，**不要手改产物**。

## 动词

| 目的 | 命令 |
|---|---|
| 建/重建索引 | `index [--repo DIR]` |
| 任务相关符号（英文/符号名关键词） | `for "english keywords" [--top N] [--max-tokens N]` |
| 定义 / 谁调用它 / 它调用谁 | `symbol NAME` / `callers NAME` / `callees NAME` |
| 改动爆炸半径 | `impact NAME [--depth N] [--types]` |
| 一个符号的全貌 | `context NAME`（定义 + 记忆 + 调用者 + 半径 + 类型引用 + 导入） |
| 改动波及面（PR 复核） | `affected --diff [rev]` / `affected --files a.rs,b.ts [--depth N] [--types]` |
| 接口↔实现 / 类型引用 / 依赖面 | `impls NAME` / `typerefs NAME` / `imports NAME` |
| 枢纽榜 / 歧义组 | `hubs [--top N] [--explain]` / `amb [NAME] [--top N]` |
| 仓库地图（文件 → 符号） | `tree [--top N]` |
| 文件级度量 | `files --by size\|syms\|cx\|dupes [--dir PREFIX]` |
| 记/查经验（绑符号或文件） | `note --sym NAME --text "..." [--tags a,b] [--kind K] [--alias a,b] [--rel SYM1,SYM2] [--id ID]` / `notes [--sym NAME] [--kind K] [--contains TEXT]` / `notes --drift` |
| 模块边界治理（读策略声明） | `policy [--policy FILE] [--all]` / `policy --baseline-update`（人工刷账） |
| 五阶段流水线（每阶段耗时 + counts） | `pipeline [--out DIR]` |
| 人读版地图（可入库、可 diff） | `export [--out FILE]` → `.repoctx/MAP.md` |
| 产物与源码是否一致 | `check` |

`for` 的任务文本用英文或符号名（排序靠子词匹配，中文无分词）。

输出是单层标签行，读法：

- `<s ...>` 一条符号：`t` 类型 / `n` 名字 / `p` 路径 / `l` 行号 / `in` 入度 / `cx` 圈复杂度（`cxOwn` 为扣除嵌套定义后的值）/ `q` 限定名 / `rank` 词频分 / `hub` 枢纽分。
- `prov` 是边的来源，取值：`same-file`、`name`、`scope-unique`、`qname`、`lexical`、`visibility`、`alias`、`doc`、`dispatch`。**引用结论时带上动词与 `prov`**，读者才能复核。

## 诚实性约定（不要把近似当事实）

- 入边类结果自带置信度：`conf="none"` 表示该名字有歧义、引用未连边，**`n=0` 不代表无人使用**；`conf="low"` 表示泛用名，可能混入同名标准库调用。这是标注，不是修复。
- 精确名未命中时会按子串模糊返回，并在输出里打印提醒——**必须核对**，别把别的符号的闭包当答案。
- 同名多处定义默认不连边（宁缺毋滥），聚合成 `amb` 组；用 `amb NAME` 展开候选再判断。
- `cx` 是**符号 span 内**的分支数（含嵌套定义）。判单个函数复杂度看 `cxOwn` 或叶子符号；排"哪片代码最重"用 `files --by cx`。
- `files --by dupes` 只是同名线索，**同名 ≠ 副本**。
- 不支持：重载/泛型的精确消歧、跨语言 FFI、运行时信息。

## 抽取器两档（行级就够用，AST 是可选增强）

**不装任何组件也能用全部动词**：默认行级抽取器零依赖、跨平台，`index` / `symbol` / `callers` / `impact` / `affected` / `hubs` / `files` 等全部可用。

装上 AST 层会**更准**（圈复杂度按决策点计数、`q=` 限定名、类型引用与导入绑定才有数据）。实测差距（对象：117 个 `.rs` 的 Rust 项目）：

| | 行级（默认） | AST（可选，装了之后） |
|---|---|---|
| 抽取符号数 | 3083 | **8023** |
| `imports` / `typerefs` | 返回空（预期） | 有数据 |

```bash
npm install --prefix "<SKILL_DIR>" web-tree-sitter@0.20.8 tree-sitter-wasms
```

必须 `web-tree-sitter@0.20.8`（0.27 与 tree-sitter-wasms 的 ABI 不兼容）。**未安装时自动落回行级，不失败、不阻塞**——先跑行级，觉得需要更准再装。

## 产物（一份仓库记忆体）

| 文件 | 由谁产生 | 性质 | 是否入库 |
|---|---|---|---|
| `.repoctx/map.json` | `index` | 机器事实，可重建、不含时间戳 | 否 |
| `.repoctx/notes.jsonl` | `note` | 人写经验（含 kind/别名/一跳关系），追加式、不可重建 | 是 |
| `.repoctx/MAP.md` | `export` | 人读投影，可 diff、可评审 | 是 |
| `.repoctx/config.json` | 人 | 枢纽打分白名单与系数 | 是 |
| `.repoctx/policy.yaml` | 人 | 模块边界声明（归不归管/依赖谁/对外入口/owner），可 diff | 是 |
| `.repoctx/baseline.json` | `policy --baseline-update` | 已接受的存量边界违规账本（fingerprint 认账） | 是 |

### policy 动词（模块边界治理）

在 `.repoctx/policy.yaml`（architecture-policy 风格的最小子集）声明每个模块的 `roots` / `managed` / `requires` / `publicEntrypoints` / `owner`，`policy` 动词对索引产物做五类检查：`module-dependency`（跨模块依赖未声明）、`deep-import`（引用绕过公共入口）、`cycle`（模块环）、`unknown-module`、`missing-entrypoint`。

两条与生俱来的纪律（照抄 zcode architecture-governance）：

- **managed 开关**：`managed: false` 的模块只登记拓扑、不产生违规——旧代码先标注"不归管"，渐进纳管，不制造几万条存量违规。
- **fingerprint + baseline，只拦新增**：违规身份 = `sha256(rule\0file\0detail)` 前 16 位；存量违规由 `baseline.json` 认账，只有**新增**违规才 `exit 1`。账本只能 `policy --baseline-update` 人工刷新（评审过的变更才能改账），检查器从不自动写账。

诚实边界：跨模块依赖 = 调用图（非 doc）+ imports 绑定中**名字唯一**的引用（同名歧义一律跳过）；`deep-import` 是**过近似**（门面再导出的内部实现可能被误报），违规行带 detail，人工评审收尾；头部 `unmappedEdges` 披露落在所有模块根之外的边数——偏大说明 roots 漏了目录。

## 纪律

1. 改完代码重跑 `index`；提交前跑 `check`（0 漂移 + git 新鲜度 + 笔记漂移候选三合一）。
2. `map.json` 不入库，其余产物入库（评审要 diff）。
3. 文档与结论里的实测数字会过期，引用旧数字前先重跑对应动词。
4. **声称可安全删除前，跑全量 `callers`**（勿在 `--top` 裁剪过的输出上下结论）；`callers n=0` 只能读作"没找到静态引用"——先看 `conf` 与 `re-exported-by`（barrel 转发不产生调用边），再下结论。
5. `policy` 的新增违规是提交闸门，`--baseline-update` 是人工决策不是例行操作。

## 常见问题（FAQ）

- **`imports` / `typerefs` 返回空？** → 行级模式下属**预期**，这两项只有 AST 层才有数据（见「抽取器两档」）。
- **输出 `n="0"` 是不是没人用？** → 先看 `conf`：`conf="none"` 表示该名字有歧义、引用未连边，**不代表无人使用**；`conf="low"` 表示泛用名，可能混入同名标准库调用。
- **`symbol` 报找不到？** → 精确名未命中会按子串模糊返回并打印提醒，回退结果**必须核对**；同名多处定义用 `amb NAME` 展开候选。
- **大仓库能跑吗？多久？** → `index` 为秒级；>2MB 的单文件会被跳过，且不计入漂移检查。
- **`check` 报漂移？** → 重跑 `index` 重建，**不要手改 `map.json`**（它不入库、可随时重建）。
- **中文能查吗？** → 符号名可以；但 `for` 的任务文本请用英文或符号名（排序靠子词匹配，中文无分词）。
- **`cx` 和 `cxOwn` 怎么区分？** → `cx` 是符号 span 内的分支数（含嵌套定义，容器符号会偏高）；判单个函数复杂度看 `cxOwn`。
- **只想看"哪些文件最大 / 最复杂"？** → `files --by size|syms|cx|dupes`。
- **`notes`（仓库经验）放哪、要不要入库？** → `.repoctx/notes.jsonl`，**要入库**（人写内容不可重建）；`map.json` 则不入库。
- **`check` 为什么会因 git 失败退出？** → 本地落后自己的上游、或（无本地提交时）落后主分支超阈值（默认 50，`--max-behind` 调整）：在旧基线上的索引与结论不可信，先 `merge --ff-only`。本检查不联网，需要最新远端先手动 `git fetch origin --prune`；`--no-freshness` 可关。
- **`check` 报"笔记漂移候选"？** → 笔记绑定的符号/文件已不在索引（重命名/删除）。用 `notes --drift` 查看，人工确认后用 `note` 追加改写版——**不要手改 jsonl，旧条保留作历史**。
- **`policy` 报违规但我不想现在修？** → 评审确认后 `policy --baseline-update` 入账，之后只有**新增**违规才拦。账本 `baseline.json` 入库，diff 可见你"认了哪些债"。
- **`for` 输出里有"没有任何精确符号名命中"提示？** → 结果是子串/词频匹配，可能整体不相关——改用符号名关键词重查，引用前逐条核对。

## 样例

`assets/demo/` 是一个极小语料（Python + TypeScript）。照着 `references/examples.md` 跑一遍，可看到每个动词的真实输出。
