# 自研 LSP→SCIP 桥的可行性实测（2026-09-15）

## 一句话结论

**可以自研，且在有依赖的完整工程里精度更高；但在本仓库现状下精度显著更低、效率慢一个数量级。**
证据是实测出来的，不是推断。

- 精度：地面真值 26 处引用 / 10 文件 → **LSP 只回 1 处 / 1 文件**（漏 96%），而本索引器回 **26 / 10**（准）；
- 效率：LSP 方案需 **5087 次 `references` 往返 ≈ 137s**（实测单次 avg 27ms、max 93ms），vs 本索引器**全量 4s**。

---

## 一、先纠正 schema：4 处会导致解码失败或语义错位

权威来源：<https://scip-code.org/docs.html>（由 scip.proto 生成；仓库已从 sourcegraph/scip 迁到 scip-code/scip）。

| 你的写法 | SCIP 实际定义 | 后果 |
|---|---|---|
| `Occurrence{ start_line=1, start_column=2, end_line=3, end_column=4 }` | **`range` = `repeated int32`（字段 1）**，必须 3 或 4 元素：`[startLine, startChar, endChar]` 或四元组；行列 **0-based** | wire 布局完全不同：消费端要么解码失败，要么把"行号"读成"结束列"——**静默错位** |
| `symbol = 5` / `symbol_roles = 6` | **`symbol = 2`**、**`symbol_roles = 3`**（按声明顺序） | 字段号错，解不出来 |
| `SymbolRole{ Definition=1, Reference=2, Implementation=4, Override=8 }` | **没有 `Reference` 这个值**。位集：`Definition=1`、**`Import=2`**、**`WriteAccess=4`**、`ReadAccess=8`、`Generated=16`、`Test=32`、`ForwardDefinition=64`。官方原话：*"Is the symbol defined here? If not, this is a reference."* —— **引用 = 不带 Definition 位** | 你的 `2` 被读成 Import、`4` 被读成 WriteAccess，**语义全错**；且 **SCIP 里没有 Implementation 位**，接口实现只能走 `SymbolInformation.relationships` |
| `Metadata.tool_info = string` | **`tool_info` 是 `ToolInfo` message**（`name`/`version`/`arguments`） | 字段类型不符，解码失败 |
| `rust://myapp/db::Batch#push(Event)` | 官方语法**空格分隔**：`<symbol> ::= <scheme> ' ' <package> ' ' (<descriptor>)+｜'local ' <local-id>`；`<package> ::= <manager> ' ' <package-name> ' ' <version>`；descriptor **以后缀收尾**：`/`=namespace、`#`=type、`.`=term、`(...)`=method | 该字符串**不是合法 SCIP**，任何 SCIP 消费者都解析不了（注意 `#`/`.` 是 descriptor 的**结尾**符，不是 `parent#child` 的前缀拼接） |
| （缺失）`Document.position_encoding` | Rust/Go/C++ 用 **UTF-8 字节偏移**；JS/TS/JVM 用 **UTF-16**；Python 用 UTF-32 | 本仓库 **Rust 116 文件 + TS/TSX 135 文件混编**，不声明编码必然错列 |

**推论**：要喂 ripwire，必须用官方 `scip.proto` 生成绑定（`buf export buf.build/sourcegraph/scip`）。
若只自己消费，**别叫它 SCIP** —— 我们的消费端是 JS，JSON 直传比 protobuf 少一整层。

> 你方案里"把签名放进 symbol 串来区分重载"的**思路是对的**：SCIP 正是用 `<method>` 的
> **disambiguator**（`name(disambiguator).`）承载重载区分。只是语法不是 `#name(T)`，而是 `name(T).`。

---

## 二、精度实测：结论与直觉相反

环境（本机 Windows，纯 Node）：`typescript-language-server@5.3.0` + `typescript@5.9.3`，
**npm 安装 28s / 31.7MB**，无原生依赖。

探针：initialize → didOpen → `textDocument/documentSymbol` → 对每个定义 `textDocument/references`。

对照组选 `getApiErrorMessage`（定义 `frontend/src/api/index.ts:36`），因为**地面真值可 grep**：

| 来源 | 引用数 | 涉及文件 |
|---|---|---|
| **地面真值（grep 全前端）** | **26** | **10** |
| **本索引器（名字匹配 + 唯一名连边）** | **26** | **10** |
| **LSP（已 didOpen 全部 11 个文件，含 10 个引用方）** | **1**（只有定义自己） | **1** |

**漏召 96%。** 且这不是个例——所有查询都回 `1 文件`（跨文件引用全部消失）：

```
[ref] getApiErrorMessage @ src/api/index.ts:36 → 1 处 / 1 文件 (39ms)
[ref] data @ src/pages/admin/UsersPage.tsx:16 → 9 处 / 1 文件 (7ms)
[ref] title @ src/lib/graph-html.ts:170 → 4 处 / 1 文件 (3ms)
```

**根因不是 LSP 不行，是它装载不了这个工程**：`frontend/node_modules` **不存在**，
`react`/`axios`/`@/*` 别名全部解析失败 → tsserver 退化为一堆互不相识的独立文件。

**所以精度的真正公式是：** `LSP 精度 = f(工程能否被完整装载)`，**不是** `f(装了 LSP)`。

同时也要诚实记录 LSP 的**真实优势**：它确实把同名的不同定义当作不同符号（4 个 `title` 各自独立
返回引用集）——这正是本索引器靠 `amb` 承认做不到的那一层。**收益真实，但前提苛刻。**

---

## 三、效率实测：慢一个数量级

| 项 | 实测 |
|---|---|
| 服务启动 initialize | 134-139ms |
| `documentSymbol` 首调（含工程装载） | **826-841ms** |
| `documentSymbol` 后续 | 18-59ms（avg ~30ms） |
| **`references` 单次** | **avg 27ms / max 93ms** |
| 外推：5087 个定义全量查引用 | **≈ 137 秒**（仅 references，不含装载与 documentSymbol） |
| 对比：本索引器全量 `index` | **4 秒**（319 文件 / 5087 符号 / 9301 边，离线，含未提交改动） |

且 LSP 方案还要额外付出：几百 MB 依赖安装 + 一个常驻语言服务器进程。

---

## 四、版本配对坑（对本仓库尤其致命）

| 组合 | 结果 |
|---|---|
| TSLS 5.3.0 + **typescript 7.0.2**（npm 默认最新） | `documentSymbol` **80 次重试 / 40 秒全返回空**（服务器活着，回 `$/typescriptVersion`） |
| TSLS 5.3.0 + **typescript 5.9.3** | **正常**：237 / 36 / 97 个符号，首调 933ms |

而本仓库前端 `package.json` 锁的就是 **`"typescript": "^7.0.2"`**（tsconfig 注释也写着 TS7 移除了
`baseUrl`、typescript-eslint 尚不支持 TS7）。**意味着 LSP 桥要么用与工程不同的 TS 版本跑（结果与你
实际编译的不是一回事），要么等 TSLS 支持 TS7。这是生态问题，不是配置问题。**

另有两个踩过的实现细节（供将来真要做时省时间）：
1. 客户端**必须**声明 `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport = true`，
   否则服务器回旧式 `SymbolInformation[]`（位置在 `location.range`，没有 `selectionRange`/`children`）；
2. tsserver 是**懒加载**：项目未装载完时 `documentSymbol` 立刻返回空数组——真实客户端都靠"等进度/重试"绕过。

---

## 五、结论与建议（分层，不二选一）

1. **保留本索引器为默认层**：在**唯一名符号**上它已实测接近零误差（26/10 vs 地面真值 26/10），
   且离线、跨平台、4 秒全量、含未提交改动。
2. **把歧义当"例外队列"**：`amb`（532 组 / 1768 定义 / 按引用热度排序）就是天然的作业队列。
   要提精度**只对高热少数组**上语义解析——几十次往返而非五千次。
3. **优先级（收益/成本比）**：
   - **a.** 先把**依赖装上、`tsc --noEmit` 打通**（前端）——这本身有独立价值（他们 tsconfig 靠
     `noUnusedLocals` 兜底 lint）；
   - **b.** **接口实现关系**：本索引器完全没有，SCIP 用 `relationships` 表达——这是最大空白，
     但**不需要 LSP**，用命名约定/Trait 实现表即可覆盖大部分场景；
   - **c.** LSP 桥：等 a 之后评估，且只做**懒解析**，不做全量。
4. 真要 SCIP 二进制 → **给 Linux 服务器**（cargo 1.93.1 + registry 696M + target 13G 已就位，
   只差 rust-analyzer），Windows 侧不要自己拼一个"像 SCIP"的格式。

---

## 六、仍未验证的边界（不要当成结论）

- 探针**只覆盖 TS 侧**，且是**依赖未安装**的现状；
- **Rust 侧（116 文件，我们最关心的服务端）没有实测**：服务器未装 rust-analyzer，且只有 4 核 /
  3.7G 内存，跑索引会与线上服务抢资源。**"Rust 侧 LSP 精度如何"没有数据，不给结论。**
- 依赖装齐后 LSP 的召回能恢复到什么程度，**也未实测**——这是评估继续与否的第一件事。
