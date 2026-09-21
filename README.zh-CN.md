# repo-context —— 本地仓库上下文索引器（纯 Node 便携包）

> English: [README.md](README.md) ｜ 更新日志：[CHANGELOG.md](CHANGELOG.md)

---

## 0. 三层分工（实测结论，大项目必读）

实测对象：2.4 GB / 3464 文件 / Rust + TS + Python 项目。

| 任务 | 工具 | 为什么 |
|---|---|---|
| 简单文本 / 正则定位 | **自带 Grep**（ripgrep） | 单次最快（~2s）；本工具不做文本搜索 |
| **在哪实现 / `callers` / `impact` / `hubs` / `for` / 仓库笔记** | **本工具** | `index` 一次秒级（实测 3.1s / 367 文件 / 6104 符号 / 15945 边），之后每条查询 <0.3s；`callers` / `impact` / `hubs` / `for` 是 Grep 与 [aisearch](https://github.com/ForceDream/ai-search) 都没有的能力 |
| 读函数体 / 行归属 / 大文件分页 | **[aisearch](https://github.com/ForceDream/ai-search)** | `read <file>#<sym>` / `context` 是 O(单文件) 操作，又快又省 token |

**一句话**：本工具负责**定位与影响面分析**（有索引、瞬时返回），aisearch 负责**精读**，Grep 负责**纯文本**。索引是一次性成本，重复查询越多收益越大；改代码后重跑 `index`、提交前 `check` 即可。

> 纯 Node（核心零依赖）· 离线 · 跨平台 ｜ 核心功能**零依赖、开箱即用**；可选 AST 增强（tree-sitter wasm，约 49.5MB）**不入库**，用 `npm install` 或安装脚本 `--with-deps` 获取，装与不装都不影响可用性

---

## 1. 这是什么

把「源码 → 符号 → 关系图 → **确定性问答**」自建出来的索引器：

- 只要 **Node** 即可运行（行级抽取零依赖）、**离线**、**跨平台**；
- 索引**本地工作树**（含未提交改动）；
- 答案来自可重建、可漂移校验的 `.repoctx/map.json`（schema `repoctx/2`，版本不符**显式失败**）。

它回答的问题与 ripwire 同一批，可作为 ripwire 的**本地替代**：精度较低，但永远可用。

---

## 2. 安装

### Linux / macOS

```bash
bash install.sh                # 装技能（行级模式，零依赖即可用）
bash install.sh --with-deps    # 额外 npm install，装上 AST 增强（更准）
bash install.sh --target="$HOME/.agent-skills/repo-context"
```

### Windows

```powershell
.\install.ps1
.\install.ps1 -WithDeps
.\install.ps1 -Target "$env:USERPROFILE\.agent-skills\repo-context"
```

> 默认技能目录 `~/.agent-skills/repo-context`（Windows：`%USERPROFILE%\.agent-skills\repo-context`）；请用 `--target=` / `-Target` 指向你**实际使用的 Agent 技能目录**。

### 不装技能，直接跑

```bash
node scripts/repoctx.mjs index
node scripts/repoctx.mjs for "auth token refresh"
node scripts/repoctx.mjs impact <符号名> --depth 3
```

自测：`npm test`（Node 内置 test runner，零依赖，120 条）。

---

## 3. 命令速查

```text
index [--repo DIR]                      建/重建索引（未提交改动也在内）
pipeline [--out DIR]                    五阶段流水线：每阶段耗时 + counts；可导五个派生视图
for "<english keywords>" [--top N]      任务相关符号（排序 = 词频主序 + 枢纽分微调）
symbol NAME | callers NAME | callees NAME | impact NAME [--depth N] [--types]
context NAME                            定义 + 记忆 + 调用者 + 爆炸半径 + 类型引用 + 导入 + 文档入口
affected --diff [rev] | --files a.rs,b.ts [--depth N] [--types]   # PR 复核：seeds + 波及并集
impls NAME                              接口/实现双向（trait→impl / 类型→trait；方法带提供者数）
typerefs NAME                           类型引用双向（不进调用图）
imports NAME                            依赖面：哪些文件导入了这个符号（AST 导入绑定）
hubs [--top N] [--explain]              枢纽榜；--explain 打印每个打分因子
amb [NAME]                              歧义组（同名定义 >1；带名字则展开该组全部候选）
tree [--top N]
files [--by size|syms|cx|dupes] [--dir PREFIX]   文件级度量（最大/最密/最复杂/同名文件分组）
note --sym NAME --text "..." [--tags a,b]        记经验（绑符号；或 --file PATH）
notes [--sym NAME] [--contains TEXT]
export [--out FILE]                     → .repoctx/MAP.md（人读版，可入库/可 diff）
check                                   产物与源码是否一致（0 漂移；提交前用）
```

> 声明层缺口普查：`node scripts/repoctx-decl-audit.mjs --strict`
> PR 复核 hook：`node scripts/install-hooks.mjs`（幂等、只动托管块、**永不阻断推送**）；`node scripts/pr-affected.mjs --base origin/HEAD`

**规律**：`for` 的任务文本用**英文 / 符号名**（排序靠子词匹配，中文无分词）；结论带 `prov`（边来源）便于复核。

---

## 4. 两档抽取器

| | 行级（默认，零依赖） | AST / tree-sitter（可选安装） |
|---|---|---|
| 依赖 | 无 | `web-tree-sitter@0.20.8` + `tree-sitter-wasms`（wasm，跨平台） |
| 注释/字符串里的标识符 | 剥离 | 天然排除 |
| 局部变量 | 缩进近似判定 | 按列号精确 |
| `cx` 圈复杂度 | 近似 | AST 决策点计数 |

未安装 `node_modules` 时**自动落回行级**，功能完整、精度略低（不失败）。

---

## 5. 目录

```
repo-context/
├─ README.md（English）/ README.zh-CN.md（中文）
├─ install.sh / install.ps1       ← 一键安装（Linux·macOS / Windows）
├─ SKILL.md                       ← 技能本体：动词表 / 抽取器 / 记忆体模型 / 诚实性约定 / 纪律
├─ package.json / package-lock.json
├─ docs/         pipeline · lsp-bridge-evaluation
├─ scripts/      20 个 .mjs + repoctx.cmd（含 9 个测试文件，`npm test` 运行）
└─ node_modules/ 可选（tree-sitter wasm，npm install 获取；不入库）
```

---

## 6. 四个产物 = 一份仓库记忆体

| 文件 | 谁产生 | 性质 | 是否入库 |
|---|---|---|---|
| `.repoctx/map.json` | `index` | 机器事实：从源码派生、可重建、不含时间戳 | 否 |
| `.repoctx/notes.jsonl` | `note` | 人写经验：追加式、带日期、不可重建 | 是 |
| `.repoctx/MAP.md` | `export` | 人读投影：机器事实 + 笔记的只读渲染 | 是 |
| `.repoctx/config.json` | 人 | 打分白名单与系数 | 是 |

---

## 7. 维护须知

1. 改完代码重跑 `index`（秒级）；提交前跑 `check`；不一致就重建，**不要手改产物**。
2. 改了 `scripts/` 要**同步到已安装目录**（重复跑安装命令；`node_modules` 不必重装）。
3. **依赖版本坑**：`web-tree-sitter@0.27` 与 `tree-sitter-wasms`（ABI 14）**不兼容**，必须 `0.20.x`；且 `Parser.Language` 要在 `Parser.init()` **之后**取。
4. **换行/BOM**：`.sh` 用 LF；`.ps1` 带 UTF-8 BOM。
5. 文档里的实测数字**必须带日期**，引用旧数字前先重跑对应动词核对。

---

## 8. 诚实边界

- **in-edges 结果自我标注置信度**：`conf="none"`（歧义名，引用不连边 → **`n=0` 不代表无人使用**）；`conf="low"`（泛用名，名字级匹配可能混入同名 stdlib 调用）。这是**标注不是修复**。
- **`cx` 口径**：它是**符号 span 内**的分支数（含嵌套定义）；判单函数复杂度看 `cxOwn` 或叶子符号。
- **`files --by dupes`**：同名 ≠ 副本，只是线索。
- **同名多处定义默认不连边**，聚合成 `amb` 组，只用 `prov` 可解释的规则消解。
- **不支持**：重载/泛型的精确消歧、跨语言 FFI、运行时信息。

---

## 9. 版本与来源

- 内容来源：仓库版控副本 + 用户级技能目录
- 工具链：Node ≥ 18（核心零依赖；与 `package.json` 的 `engines` 一致）
- 与 `ripwire/` 配套：**精度要 ripwire，可用性要 repo-context**。
