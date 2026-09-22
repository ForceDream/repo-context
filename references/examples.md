# repo-context 样例（真实输出）

`<SKILL_DIR>` = 本技能目录（即 `SKILL.md` 所在目录），加载技能时系统会给出其绝对路径（Base directory）。

语料：`assets/demo/`（3 个源文件、15 个符号）。把 `assets/demo` 复制到任意临时目录后，用该目录作 `--repo` 执行下面命令。以下输出为实测原样（Windows + Node 24，行级抽取器）。

```powershell
Copy-Item -Recurse -Force "<SKILL_DIR>\assets\demo" "$env:TEMP\demo"
node "<SKILL_DIR>\scripts\repoctx.mjs" index --repo "$env:TEMP\demo"
```

## 1. `index` —— 建索引

```
✓ 已索引 ..\..\AppData\Local\Temp\demo
  文件 3 · 符号 15 · 边 21 · 歧义未连 0 · 函数局部引用 3（非 API，单列不计歧义）
  产物 .repoctx/map.json（3 KB，不含时间戳→可做 0 漂移校验）
  抽取器：行级（AST 未启用，原因：web-tree-sitter 加载失败：Cannot find package 'web-tree-sitter' …）
```

第一行打印的是仓库目录**相对当前 shell 目录**的路径，不是仓库本身的位置。

`AST 未启用` 是**正常回退提示**，不是错误：行级抽取器功能完整、精度略低。要启用见 SKILL.md「抽取器两档」。

## 2. `for "order discount checkout" --top 6` —— 任务相关符号

```xml
<ctx task="order discount checkout" schema="repoctx/2" files="3" symbols="15" edges="21" ambiguous="0">
<s t="fn" n="apply_discount" p="src/orders.py" l="14" cx="1" cxOwn="0" in="1" rank="0.0557" hub="0.357">def apply_discount(order):</s>
<s t="fn" n="total" p="src/orders.py" l="10" cx="2" cxOwn="0" in="2" rank="0.0666" hub="0.599">def total(self):</s>
<s t="fn" n="checkout" p="src/orders.py" l="19" cx="1" in="0" rank="0.0301" hub="0.000">def checkout(order):</s>
</ctx>
```

读法：词频是主序（整数命中），`hub` 只在同分候选间微调（上限 1.5，永远盖不过一次真实词频命中）。用 `hub=` 复核"为什么它排在前面"。

## 3. `context apply_discount` —— 单符号全貌

```xml
<context sym="apply_discount" t="fn" p="src/orders.py" l="14" cx="1">
  <callers n="1">
    <s t="fn" n="checkout" p="src/orders.py" l="19" cx="1" in="0" rank="0.0301" prov="same-file">def checkout(order):</s>
  </callers>
  <impact n="1" depth="2">
    <s t="fn" n="checkout" p="src/orders.py" l="19" cx="1" in="0" rank="0.0301">def checkout(order):</s>
  </impact>
</context>
```

结论可直接写进回答：`apply_discount` 只被 `checkout` 调用（`prov="same-file"`：同文件唯一同名项），改动波及面 = 1 个函数。

## 4. `callers apply_discount`

```xml
<callers of="apply_discount" n="1">
<s t="fn" n="checkout" p="src/orders.py" l="19" cx="1" in="0" rank="0.0301" prov="same-file">def checkout(order):</s>
</callers>
```

## 5. `hubs --top 4` —— 枢纽榜（多特征打分）

```xml
<hubs n="4" formula="归一化入度×类型×路径×泛用名×跨度×跨文件广度" config="(默认)" whitelist="-" genericDamp="0.15" testDamp="0.5" ambGroups="1" …>
<h rank="1" n="findToolByName" t="method" p="src/tool.ts" l="13" score="2.7000" cx="1"></h>
<h rank="2" n="register" t="method" p="src/tool.ts" l="9" score="1.7850" cx="1"></h>
</hubs>
```

`--explain` 会打印每个打分因子，用于解释排名。

## 6. `files --by cx` —— 哪片代码最重

```xml
<files by="cx" n="3" total="3" …>
  <f p="src/orders.py" lang="py" bytes="537" syms="6" cxMax="2" cxSum="8" top="Order"/>
  <f p="src/usage.ts" lang="ts" bytes="260" syms="3" cxMax="2" cxSum="5" top="describeTools"/>
</files>
```

`cxMax/cxSum` 含嵌套定义（容器符号偏高），别当成"单个函数的复杂度"。

## 7. 行级模式下会"空"的动词（诚实面）

```
$ node repoctx.mjs imports buildDefaultRegistry --repo <demo>
<imports n="buildDefaultRegistry" files="0" defs="1" …>
（没有任何文件导入「buildDefaultRegistry」——注意：glob 导入（import * as ns / use x::*）不产生绑定）
```

```
$ node repoctx.mjs typerefs ToolRegistry --repo <demo>
<typerefs n="ToolRegistry" defs="1" inEdges="0" outEdges="0" …>
（没有解析到类型边：同名类型定义可能不唯一，或该名字出现在类型位但仓库内无对应类型定义）
```

`imports` / `typerefs` 的数据来自 AST 层；行级模式下返回空是**预期行为**，不要据此断言"没有依赖"。装上 AST 增强后同一命令会给绑定/类型边。

## 8. `check` —— 提交前的漂移闸门

```
$ node repoctx.mjs check --repo <demo>
✓ 索引与源码一致（0 漂移）
⚠ MAP.md 不存在：跑一次 `repoctx export` 生成（入库供评审 diff）
```

## 9. 记一条经验

```powershell
node "<SKILL_DIR>\scripts\repoctx.mjs" note --sym apply_discount --text "折扣率来自配置，改这里要同步 pricing 文档" --tags pricing,config --repo "$env:TEMP\demo"
node "<SKILL_DIR>\scripts\repoctx.mjs" notes --sym apply_discount --repo "$env:TEMP\demo"
```

笔记写入 `.repoctx/notes.jsonl`（入库），之后 `context` / `MAP.md` 会带上它。
