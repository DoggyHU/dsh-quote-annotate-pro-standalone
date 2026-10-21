# dsh-quote-annotate-pro · 汇总

> 一份把"调研 → 选型 → 排障 → 改造 → 验证"全部收拢的文档。
> 环境：Windows 桌面版 **DSH 0.2.0-rc.2**，profile = `desktop`，GUI `http://127.0.0.1:19387`（`DSH_HOME` 视安装而定）。

---

## 1. 一句话

在 DSH 会话里**划词 → 批注 → 引用**：选中的文字带锚点进入输入框，发送时序列化成结构化引用块；输入框下方常驻**引用导航条**，点一下跳回原文并高亮。多轮对话里模型看到的是 `【引用 · 第N轮 · 你的消息】`，精确知道"你说的是哪一处"。

## 2. 现状速览

| 能力 | 状态 |
|---|---|
| 划词 → 浮出气泡 → 「批注」→ 编辑框 | ✅ 已验证 |
| 输入框内引用 chip（`引用#1 · 第N轮 · 角色`） | ✅ 已验证 |
| 输入框下方引用导航条：点击跳回原文 + 高亮 | ✅ 已验证（日志 `jump:ok`） |
| 悬停引用预览原文 | ✅ |
| 回合尾部「引用提问 / 引用回答」 | ✅ 已验证（4 个回合均取到文本） |
| 引用块带轮次/角色，模型侧精确定位 | ✅ 用户实际发送的引用消息为证 |
| 锚点刷新后仍可跳（localStorage） | ✅ 已实现（按会话，60 条上限） |
| 输入框 chip 本体点击跳转 | ✅ 按 `title` 反查 ref 实现 |

**上手 3 步**：① 消息里划词 → ② 点「批注」写评语（可留空）→ `Enter`；③ 点输入框下方引用条或回合尾部按钮跳回原文。

## 3. 背景与调研

需求：划词引用 + 多轮对话精准定位。先查市场，再查 GitHub：

| 候选 | 来源 | 能力 | 结论 |
|---|---|---|---|
| **dsh-quote-annotate** ★6 | [GitHub](https://github.com/wangwei-wade/dsh-quote-annotate) · npm `0.1.1` · MIT | 划词批注 + 锚点 chip + 点击跳回 + 回合级引用 | **选它做基础**（最贴合），但在本机静默失效 → fork |
| dsh-ui-quote-selection | [nekogpt](https://github.com/nekogpt/dsh-ui-quote-selection) · npm `0.1.0` · MIT | 选中即引用，走官方 codec，发送时展开全文 | 无回跳/批注，多轮定位弱 |
| dsh-selection-ask ★5 | npm `0.1.1` · MIT | 选中弹「Ask …」（ChatGPT 式） | 轻量，无锚点回跳 |
| dsh-sidenote ★10 | npm `0.4.5` | Codex 式侧聊 + 选区批注 | `engines: <0.2.0` → **不兼容本机** |
| dsh-plugin-quote-reply | npm `0.1.0` | 划词引用 / 新窗口回复 | peer 停在 `0.1.0-rc.6`，偏旧 |
| dsh-selection-quote | [cfyofjackie](https://github.com/cfyofjackie/dsh-selection-quote) · MIT | 选中即插入原子引用 | 未发 npm，0★ |

市场侧：`deepseek1024.com` 目录（13,769 个插件）检索 `quote / 引用 / 选区` 命中上述多个；本机另装有 `dshmarket` 市场插件（其数据源 `awesome-dsh-plugin.com` 在本网络不可达）。

## 4. 上游为什么在本机失效（6 个兼容性问题）

> 前两个会让插件**完全不报错地什么都不做**，这是"有气泡但点批注没用 / 没有按钮"的根源。

| # | 症状 | 真因 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | 一个 UI 都不注册，且无报错 | `apply()` 里 `ctx.get('slots')` 拿不到就 `return`，但**未声明** `inject: ['slots']`，可能早于服务就绪执行 | 加 `exports.name`/`exports.inject=['slots']` 后立刻 `register:ok …` | 声明 cordis 依赖 + 每步 `try/catch` + 上报 |
| 2 | 后续 4 个 overlay 注册全不执行 | `conversation.chat.turnTail` 自 0.1.6-alpha.2 **由 chain 变 list**，上游仍用 `{select, priority}` 注册 → 抛错，而它排在 overlay 之前 | Inspect 显示该槽 `kind: "list"`，注册参数为 `id/order/label` | 改 `{name, id, order}` |
| 3 | 引用永远退化成纯文本、chip 不生成 | 调用 `input.insertReference(...)`，该对象在本版本**没有**此方法 | `probe:emit-ok {"viaScope":true,"draftRev":34}` | 改走会话事件 `slash/input-insert-reference`（`dsh-better-sidebar` 同款已验证通路） |
| 4 | 点「批注」只关掉气泡，什么都不发生 | 读 `useSessions(s => s.current)`，而**本版本会话列表快照没有 `current` 字段**（恒 `undefined`）→ `if (current)` 不成立 | `env:overlay-props {"keys":[…],"hasSessionId":false}`；社区插件 `dsh-better-sidebar` 源码注释明确记载该字段不存在 | 用**会话作用域探针**（`conversation.input.dock`）回填 `sessionId`；去掉"必须先有会话才开编辑框"的门槛 |
| 5 | 回合尾部「引用提问/回答」不出现 | 用 `useSession` 快照 + `Array.isArray(nodes)` + 节点 `seq` 取文本；本版本真实形状是 **Chat 快照（`useChat`）**、**`nodes` 是 Map**、身份字段 **`anchorSeq`**、assistant 节点 kind 是 **`assistant-step`**、文本在 `data.content[{type:'text'}]` / `data.blocks[{kind:'text'}]` | `turnTail:render {"turn":6,"userChars":48,"assistantChars":1734,…}` | 按本版本形状重写取文与锚点解析 |
| 6 | 「点输入框里的 chip 跳回」不可能成立 | 本版本 chip 的 DOM **没有 `data-occurrence`**（只有 CSS 类，`title` 是 label） | 在 conversation 客户端 bundle 中检索 `data-occurrence` 无匹配 | 主入口改为**引用导航条**；chip 本体按 `title` 反查 ref |

## 5. 本 fork 的增强

1. **引用块带位置**：首行 `【引用 · 第N轮 · 角色】`（轮次 ← `data-chat-turn`，角色 ← `data-chat-flow-kind`），解决"多轮里模型不知道指哪一处"。
2. **当前会话解析**：会话作用域探针（dock 槽位）→ 右侧栏 `sidebarRight.mounted` 兜底。
3. **引用导航条**：注册进 `conversation.input.dock`，读官方输入状态 `occurrences`（`source === 'quote-ref'`），点击跳回 + 高亮 + 悬停预览。
4. **锚点持久化**：`ref → {anchorKey, body, label}` 写入 `localStorage`（`dsh-quote-pro:ref:<sessionId>`，60 条上限），刷新后仍可跳。
5. **输入框 chip 本体可点**：按 `title`（= 插入时的 label）反查 ref，不依赖 CSS 类顺序。
6. **诊断通道**：启动 `POST /ping`，探测不到接收端则本次运行静默（避免网络噪音）；`DIAG_ENABLED=false` 可彻底关闭。

## 6. 实现要点

```
划词 → 气泡「批注」→ 编辑框 → Enter
  ▼
emit('slash/input-insert-reference', { reference, span })      ← 会话作用域事件
  ▼  输入机 mint 一条 occurrence（source='quote-ref' / ref / label）
输入框 chip（官方 Lexical 装饰节点）
  ▼  发送时本插件 codec.serialize(ref)
【引用 · 第N轮 · 角色】
> 原文……
（你的评语）

跳回：导航条/chip → [data-chat-anchor-key] 行 → scrollIntoView + .dshq-flash 高亮
```

用到的官方接口：`slots`（`shell.overlay` / `conversation.chat.turnTail` / `conversation.input.dock`）、
`conversation.input`（草稿 + occurrences）、`sessions.binding` / `sessions.scope`、
`inputTriggers.registerSource` + codec、DOM 锚点 `data-chat-anchor-key` / `data-chat-turn` / `data-chat-flow-kind`。

槽位占用（`Slots` Inspect 实测均为 `active: true`）：
`shell.overlay`：`quote-pro-selection-toolbar` / `quote-pro-annotation-editor` / `quote-pro-feedback-toast` / `quote-pro-tooltip`；
`conversation.chat.turnTail`：`quote-turn-actions`；`conversation.input.dock`：`quote-pro-session-probe` / `quote-pro-quote-dock`。

## 7. 验证记录（诊断日志实测）

```
session:resolved  {"via":"dock-probe"}                                   ← 会话解析成功
probe:emit-ok     {"viaScope":true,"draftRev":34}                        ← chip 插入通路（零副作用探针）
insert:chip       {"header":"【引用 · 第6轮 · DSH 回复】","chars":26}      ← 引用块带位置
dock:rows         {"count":1} → dock:click → jump:ok → toast ok | 已跳转到原文 ✓   ← 跳回全链路
turnTail:render   {"turn":4..7,"userChars":11/2/48/7,"assistantChars":844/1219/1734/94}  ← 回合按钮取文
```
用户实际发送的引用消息（模型侧可见）：
`【引用 · 第2轮 · DSH 回复】` / `【引用 · 第6轮 · DSH 回复】`。

## 8. 文件与安装

```
dsh-quote-annotate-pro/
├── lib/client.js       全部功能（手写 bundle：window.__ModuleLoader__.load 工厂式 CJS，无构建步骤）
├── lib/index.js        Host 半区空占位
├── cordis.patch.yml    插入 Loader 行 quote-annotate-pro
├── package.json        dsh.bundle.patch + dsh.client{platform:'web'}
├── tools/diag-sink.mjs 本地诊断接收端（开发期可选）
├── README.md           功能 / 与上游差异 / 原理 / 诊断开关 / 已知限制
├── SUMMARY.md          本文档
└── LICENSE             MIT（保留上游 wangwei-wade 署名）
```

安装（本机开发时为 `link:` 方式 → **改文件即热更，无需重启**）：

```
<profile>/package.json
  "dsh-quote-annotate-pro": "link:<本仓库绝对路径>"
```

卸载：`插件管理器 remove_bundle dsh-quote-annotate-pro`。上游 `dsh-quote-annotate` 已从 profile 卸载。

## 9. 已知限制

- 输入框 chip 跳转按 `title` 反查，label 相同只会命中最早一条（导航条始终精确）。
- 跳转要求目标消息行在当前页面；未加载的历史只给提示，不自动翻页。
- 回合尾部按钮现在**总是显示**（上游在有交付文件的回合会隐藏，让位给官方「已生成文件」chips）。
- 评语以纯文本追加在 chip 之后；删 chip 用 Backspace。

## 10. 可继续做

1. **发送后的引用也能点**：在 transcript 里识别 `【引用 · 第N轮 · …】` 块，点击跳回该轮。
2. **跨会话跳转**：锚点已按会话存储，可扩展到"切到目标会话并定位"。
3. **自动翻页加载**：目标轮次未加载时调用 `loadThrough` / `loadOlder` 后再定位。
4. 回合尾部按钮恢复"有交付文件时隐藏"的上游语义。

## 附：时间线（本次会话）

1. 调研市场 + GitHub，确认已有同类插件 → 选 `dsh-quote-annotate` 装进 desktop profile。
2. 发现"装了但毫无反应" → 用本地诊断接收端 + 自研上报确认插件**加载了却没注册任何 UI**。
3. fork 出 `dsh-quote-annotate-pro`，逐个修复 6 个兼容性问题（上表）。
4. 补齐 6 项增强，并把诊断从"临时排查"固化为"探测不到即静默"的通道。
5. 用户实测：划词→批注→chip→导航条跳回→发送后引用块 全链路通过；回合尾部按钮修复后取文正常。
