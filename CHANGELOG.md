# repo-context 更新日志

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
