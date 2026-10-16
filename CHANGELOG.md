# repo-context 更新日志

## [1.2.2] - 2026-10-16 · 清理版（AST 并行修复）

### 修复

- AST 并行抽取静默失效：主流程调用并行脚本时 `stdio[0]='ignore'` 使子进程 stdin 立即 EOF、清单读空，实际从未走并行（表现为"没变快"）；改 `stdio[0]='pipe'` 后并行生效（实测 348 文件 2.58s→1.72s，产物与串行 sha256 一致）
- `index` 输出的抽取器行追加并行状态（`并行×N`），并行成败不再无痕迹
- 并行脚本剥离 stdin 清单的 UTF-8 BOM（手工管道调试时不再静默解析失败）

### 清理

- 删除零引用导出：`repoctx-decls.mjs` 的 `sumCounts` / `mergeClassified` / `loadLocalForms`（连同未使用的 `node:fs` 导入）
- `package.json` 版本对齐技能版本（此前漏改）

### AST 依赖回归（安装 web-tree-sitter + tree-sitter-wasms 实测）

- AST 抽取：符号 706 vs 行级 691、边 825 vs 1944（精确抽取显著降噪）、耗时 0.83s vs 0.28s
- 并行 / 串行产物 sha256 一致；抽取器行显示 `并行×N`
- 全量测试 123 个：98 通过 / 0 失败 / 25 跳过

## [1.2.1] - 2026-10-13 · 修复版（索引覆盖 / 传参）

### 修复

- **漏掉未跟踪文件**：`listSourceFiles` 此前只用 `git ls-files`（仅已跟踪），新建、还没 `git add` 的文件不进索引 —— 刚写的代码 `def` / `callers` / `for` 全都查不到。现在并入 `git ls-files --others --exclude-standard`（仍尊重 `.gitignore`），并同步文档写明索引范围
- **并行清单走 argv 会静默退化**：`index` 把整个文件清单 JSON 塞进单个命令行参数，超过 Windows 命令行上限（约 32KB）时 `execFileSync` 失败并静默退回串行（不报错、白丢并行）。改为 `--files -` 由 stdin 传递

## [1.2.0] - 2026-09-30 · 索引排除优化（大仓提速）

### 新功能

- 项目级排除 `skipDirs`（`.repoctx/config.json`）：**目录名**（任意层级命中）、**相对路径前缀**、**含 `*` 的路径段通配**三种写法，把"不是本项目源码"的子树剔出索引；另有一次性 `--skip-dir a,b`。排除后文件数 / 符号数 / 歧义组同步下降：ZCode-main 默认 3965 文件 21.2s，排掉 `apps` 后 2560 文件 10.1s，同名歧义组 327703 → 157664。
- `index` 与 `pipeline` 披露生效的排除（`额外排除 apps, modules` / `skip="apps"`），排多了当场可见。

### 默认排除表扩充

- 依赖 / 第三方：`vendor`、`third_party`、`deps`、`bower_components`、`jspm_packages`、`.pnpm-store`、`.yarn`、`site-packages`
- 构建产物：`out`、`output`、`outputs`、`coverage`、`.next`、`.nuxt`、`.svelte-kit`、`.turbo`、`.parcel-cache`、`.gradle`、`Pods`、`DerivedData`
- Python 环境与缓存：`.venv`、`venv`、`__pycache__`、`.tox`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`
- 编辑器 / VCS：`.idea`、`.vscode`、`.hg`、`.svn`、`.cache`
- 归档与助手目录：`archives`、`.agents`、`.claude`、`.cursor`、`tmp`、`logs`
- **刻意不收录**：`apps`、`modules`、`lib`、`bin`、`src`、`test`、`docs`、`examples` —— 这些位置在别的项目里本就是源码，误挡真源码比多索引几个目录严重，改由 `skipDirs` 显式声明。

## [1.1.1] - 2026-09-22 · 文档修正

### 文档修正

- 修复文档内表述不准确和内容模糊的内容。
- 「抽取器两档」补明体积口径：单文件 >2MB 直接跳过且**不计入 `check` 的漂移检查**；AST 解析上限是 1MB，1–2MB 自动走行级（此前只笼统提"2MB 限制"，两档混在一起）。

## [1.1.0] - 2026-09-22 · 功能版（借鉴 zcode 治理机制）

### 新功能

- **`policy` 动词（模块边界治理）**：读 `.repoctx/policy.yaml`（architecture-policy 风格最小子集），做五类检查——`module-dependency`（跨模块依赖未声明）、`deep-import`（引用绕过公共入口）、`cycle`（模块环，只报含 managed 的）、`unknown-module`、`missing-entrypoint`。`managed: false` 的模块只登记拓扑、不产生违规（旧代码渐进纳管）。新增 `scripts/repoctx-policy.mjs`（解析器 + 检查器，零依赖）。
- **fingerprint + baseline，只拦新增**：违规身份 = `sha256(rule\0file\0detail)` 前 16 位；存量违规由 `.repoctx/baseline.json` 认账，只有新增违规才 `exit 1`；账本只能 `policy --baseline-update` 人工刷新，检查器从不自动写账。
- **`check` 三合一**：原 0 漂移校验之外，新增 ① git 新鲜度（落后上游 → 失败；无本地提交且落后主分支超阈值（默认 50，`--max-behind`）→ 失败；分叉 → 警告；默认不 fetch，`--no-freshness` 可关）；② 笔记漂移候选披露（绑定的符号/文件已不在索引，人工确认，不自动删）。
- **`note`/`notes` 升级为策展种子**：新参数 `--kind`（decision/pitfall/invariant/…）、`--alias`（中文别名）、`--rel`（一跳关系：`context` 查任一相关符号会带出该笔记）、`--id`（稳定 id）；`notes` 显示新增字段并支持 `--kind`/`--drift` 过滤；`context` 的笔记命中扩为 sym/file/rel/alias 四种绑定，输出带 `kind`/`rel`/`aliases`。
- **`callers` 的 re-export 披露**：新增 `<re-exported-by>` 段（数据源：TS `export {A as B} from` / Rust `pub use` 的行级扫描，glob 跳过）——直接 callers 为 0/偏少不代表公共面小，删除前先追 barrel 路径。头部带 `reExportFiles="k"`。
- **`for` 的回退披露与预算修正**：任务词无任何精确符号名命中时当场提示（结果是子串/词频匹配，可能不相关）；空结果显式说明"无命中"；预算口径改为 `ASCII/4 + CJK/字`（旧 `len/4` 对中文严重低估），header/footer 计入预算，连 1 条都放不下时强制输出 1 条并警告。
- **SKILL.md 顶部新增「定位：附加证据，不是权威」**：结论须对照 checkout 复核；文件/符号存在 ≠ 行为存在 ≠ 有测试覆盖；工具不可用就报不可用。纪律节补"声称可删除前跑全量 callers"与 baseline 人工刷账。

### 产物变更

- `map.json` 新增 `reexports` 字段（文件 → `[{name, as}]`）；`SCHEMA` 仍为 `repoctx/2`（旧产物缺该字段时 re-export 披露静默缺席，重跑 `index` 即得）。
- 新增入库产物：`.repoctx/policy.yaml`（人写）、`.repoctx/baseline.json`（`--baseline-update` 生成）。

### 实测

- 临时测试仓（barrel + deep-import + 模块环）：`policy` 精确命中 2 类违规 → baseline 后 new=0；`callers`/`context`/`notes --drift`/`for` 提示全部按预期输出。
- baozi server（180 文件 / 2626 符号）：`check` git 新鲜度（落后 0 · 领先 21）；`callers run_agent_loop` 命中真实 barrel；`unmappedEdges` 披露正确触发 roots 检查警告。

## [1.0.1] - 2026-09-20 · 缺陷修复

缺陷修复版：修掉 6 个实测确认的逻辑错误 + 2 处文档不一致，未新增功能。

### 逻辑错误修复

- **`cxOwn` 大面积错值**：读 `endLine` 而符号对象字段名是 `el` → 取到 `undefined` 后回退 `MAX_SAFE_INTEGER`，判定恒命中、栈永不弹出，兄弟符号的复杂度被误扣。实测 `alpha`（体内无嵌套）输出 `cxOwn="1"`。已改读 `el` 并加注释记录根因（现容器符号得 `cxOwn="0"`，合理）。
- **缺位置参数抛未捕获异常堆栈**：`symbol` 触发 `TypeError`，`callers` / `callees` / `impact` / `context` 同样无守卫（而 `typerefs` / `imports` / `impls` 都有）。统一 `resolveSymbol` 守卫，输出用法并 `exit=2`。
- **`affected --files` 不做路径归一化**：Windows 写 `src\a.py` 静默得到 `seeds=0` 且无提示（posix 写法正常）。已归一化 `\` → `/` 并去 `./` 前缀。
- **数值 flag 无校验**：`--depth abc` → `depth="NaN"`、`--top abc` → `n="0"`，全是静默空结果，用户无从察觉参数写错。新增 `numFlag` 统一校验并显式报错。
- **XML 属性零转义**：`for "discount order"` 输出 `<ctx task=""discount order"" ...>`（引号嵌套、畸形）；note 文本、md 标题（会被当符号名进索引）、源码签名同样未转义。新增 `esc()` 统一转义 `& < > "`。
- **`context` 对同名多定义只取第一个**：与 `callers` / `impact` 的"聚合全部定义"口径不一致，会漏掉其余定义体。改为聚合。

### 文档修正

- `SKILL.md`：动词表补 `pipeline`（help 与实测都有，此前漏列）。
- `package.json`：`1.0.0` → `1.0.1`，新增 `engines.node >= 18`（实现用了 `??` 与 ESM）。
- `README.md`：工具链要求「Node ≥ 20」→「≥ 18」，与 `engines` 对齐。
- `references/examples.md`：`✓ 已索引 .` 实测打印的是相对 cwd 的路径 → 修正说明。

### 文档改进（已入库，随下次发版生效）

- `SKILL.md` 顶部新增「什么时候用我（触发词）」与最短上手两条命令。
- 新增「常见问题（FAQ）」：`imports` / `typerefs` 为何返回空、`n="0"` 与 `conf` 的关系、`symbol` 找不到怎么办、大仓库与 2MB 限制、`check` 报漂移、中文查询、`cx` vs `cxOwn` 等。
- 「抽取器两档」明确 **不装任何组件也能用全部动词**，并给出 AST 收益量化（实测符号数 3083 → 8023，对象为 117 个 `.rs` 的项目）。
