Status: implemented

# dsh-automode：自主审批插件（借鉴 Nuo-cl/dsh-auto-mode 的设计模式，独立实现）

> 本文档是 dsh-automode 的**当前设计与实现规格**。早前的 `proposed / 待实现 / 审查发现 / 实现确认` 分层已全部落地并合入本文；v0.5.0 审查发现的 7 个 bug、CC 式分类器缺口、熔断器复位缺陷、模型引导改进均已实现，不再单独保留历史 bug 清单。
>
> 2026-08-25 修订：本文档原题「Fork Nuo-cl/dsh-auto-mode 并重构为 dsh-automode」。本插件**并非 fork**——以自身设计为主，借鉴了 Nuo-cl/dsh-auto-mode 与 pi-automode 的思路与模式独立实现；对二者的贡献见下方「致谢与参考」。

## 核心立场

转 TypeScript（与 DSH 生态一致），以**自身设计**为逻辑基础，**参考** Nuo-cl/dsh-auto-mode 与 pi-automode 的决策链、预执行门、熔断器、两阶段分类器等设计模式（借鉴思路，非代码复用），独立实现、减少重写。

## 致谢与参考

本插件为独立实现，**未 fork 任何上游代码库**。设计上借鉴了以下项目，特此致谢：

- **Nuo-cl/dsh-auto-mode**：auto mode 概念、预执行门（pre-execute gate）、裁决缓存、熔断器、deny/allow 频带、CC 式拒绝引导等设计模式。
- **pi-automode**：两阶段分类器、`allowInsideWorkingDirectory`、`$defaults` 规则机制等设计模式。

对外说明建议措辞：`Inspired by Nuo-cl/dsh-auto-mode and pi-automode`。

## 共识（grill 产出）

| 决策 | 选择 |
|---|---|
| 代码库 | 独立实现 dsh-automode；借鉴 Nuo-cl / pi-automode 的设计模式（见「致谢与参考」） |
| npm 名 | `dsh-automode`（无连字符） |
| peerDeps | 精简到最少必需 |
| 语言 | TypeScript |
| 规则体系 | deny（正则硬拒绝）+ allow（前缀 glob 白名单）+ 散文规则给分类器 |
| 读取策略 | 只读工具默认放行，deny 列表里的敏感位置除外 |
| 决策模型 | **二态（allow / reject），无 ask 态**（2026-08-26 定稿：移除三态） |
| 分类器路由 | `classifier.provider` + `classifier.model` 独立配置 |
| pre-execute 门 | 核心差异特性，围栏内外都跑 deny/allow |
| 持久化日志 | JSONL |
| 复盘脚本 | 分析 + 建议 |
| 上游策略 | 先独立维护，后续提 PR |

## 文件结构

```
src/
  index.ts         主入口：preset 管理、审批 answerer、断电器复位、/auto + /auto-status、系统提示影子化
  config.ts        配置 schema（合并两套 + $defaults 机制 + 内置规则清单）
  bands.ts         确定性频带引擎（deny 正则 + allow 前缀 glob + 复合 shell 判定）
  pre-execute.ts   pre-execute 门（真实路径判定、curated allowPaths、分类器预审、断电器跳闸注入）
  classifier.ts    分类器（两阶段 + 鲁棒解析 + reasoningEffort + 诊断日志）
  rules.ts         散文规则匹配（$defaults 展开）
  prompt.ts        提示构造（<recent_user_intent> + 意图权重 + 危险优先）
  cache.ts         裁决缓存（按 tool+command 签名，maxArgsChars）
  breaker.ts       熔断器（3 连续 / 20 总 DENY → 跳闸）
  log.ts           持久化 JSONL 日志（appendDecision）
```

## 决策链

```
工具调用到达
  ├─ [pre-execute 门]（所有工具，第一道防线；仅 auto-mode 会话生效）
  │    ① 只读工具 → 除 deny 列表外直接放行
  │    ② deny 列表（正则）→ 直接拒绝
  │    ③ allow 列表（前缀 glob）→ 直接放行
  │    ④ allowInsideWorkingDirectory → 工作区内文件操作放行（真实 path/symlink 判定）
  │    ⑤ 升级意图 / 越区文件操作 → 裁决缓存命中？→ 分类器预审
  │    ⑥ 其余 → 放行
  └─ [approval/request 路径]
       ① deny rules（散文）→ 拒绝
       ② allow rules（散文）→ 放行
       ③ allowlist → 放行
       ④ 裁决缓存命中 → 复用
       ⑤ 分类器（两阶段：one-token 预筛 → 结构化裁决）
       ⑥ 失败 → failClosed
```

## 关键行为（已实现）

### 两阶段分类器
- `fastFilter`（one-token 预筛）：512 token 预算 + **独立 0/1 数字解析**，避免 reasoning 模型被 token 预算饿死；传入 `classifier.reasoningLevel` 作为 `reasoningEffort`；若路由不支持 effort（dsh-llm 抛 `UNSUPPORTED_REASONING_EFFORT`，或流以 `finish {kind:'error'}` 终结且 `reason.failure.code === UNSUPPORTED_REASONING_EFFORT`）则**安全回退为不传**（`streamTokens` 统一处理，抛异常与 error-finish 两条路径都重试）。
- `classify`（结构化裁决）：鲁棒解析 JSON verdict（**allow / reject 二态**）；失败返回 null → 调用方按 `failClosed` 处理。

### 熔断器
- 3 连续或 20 总 classifier DENY 触发跳闸；跳闸后 auto 暂停，审批转人工。
- **任何一次真实人工决策（allow OR reject）都解除跳闸并清零计数器**（人工参与即打破静默连拒循环）；`cancelled` / `unavailable` 不复位。
- 跳闸瞬间注入 `BREAKER_TRIPPED_HINT`，指示模型**直接在首次尝试就请求 `danger-full-access` 升级**（省去"先试→报错→再升级"往返，立即弹人工窗口）。
- 跳闸/复位分别写 `breaker` / `resume` 事件到 `decisions.jsonl`。

### 模型引导
- deny 时提示模型「尝试更安全方案」；若**没有更安全方案**，则**停止重试并询问用户明确许可**——只有用户明确批准，后续尝试才可能通过（分类器经 `<recent_user_intent>` 读到用户意图）。

### 用户意图
- 分类器经 `<recent_user_intent>`（`renderUserIntent`）读取用户**最近的显式指示**，作为「合法性」强信号；但硬安全边界（泄密/破坏/自身提权沙箱）仍优先。

### 分类器诊断
- `classifier.ts` 把 resolved `provider/model`、底层错误 code/message、以及 `raw` 模型输出写入 **DSH 日志**（不进 decisions.jsonl），用于定位 `classifier returned no verdict` 根因。
- **2026-08-25 增强**：分类器流失败（error-finish 或抛异常）除 DSH 日志外，**同时写入 `decisions.jsonl` 的 `classifier-fail` 事件**（含 `stage` / `effort` / `route` / 错误 message+code / raw 摘要），使「no verdict」可从审计记录直接复盘，不再依赖 DSH 进程内日志。

### 预执行门作用域
- 仅在 `auto-mode` 会话生效；非 auto preset（read-only / workspace-write / danger-full-access）一律放行，不与用户所选沙箱/审批预设冲突。

## 已知问题 / 待办

- **分类器路由解析**：`resolveRoute` 优先级为 `config.classifier → session request header → agent.options`；`classifier.provider/model` 为空时，分类器跟随会话**实际模型**（当前为 DeepSeek），而不是 agent 默认模型。若会话模型本身重/不稳定（reasoning 高开销）导致频繁 `classifier returned no verdict`，建议**固定专用分类器路由**（`classifier.provider/model` 指向支持 `reasoningEffort: off/low` 的轻量非 reasoning 模型，如 `ocg-completions/ox-alpha-free` 或 `ocg/deepseek-v4-flash-vision-exp`）。

- **待解决（2026-08-31）：`ask_user_question` 工具型授权不透传裁决链路，只有用户直接输入文字指令才被放行** — 现象：模型用 `ask_user_question` 询问用户、用户选了"授权推送"，随后重试同一 git push（带 danger-full-access 提权）仍被拒（`a prior identical action was judged unsafe`，旧 DENY 缓存命中）；用户**直接输入文字**"允许 push skill"后重试才放行。根因：`renderUserIntent` 只把**用户对话里的文字指令**作为意图信号并 hash 进裁决缓存签名（M-34 语义），`ask_user_question` 的选项选择是**工具结果**而非 user message → 不更新签名 → 旧 DENY 缓存继续命中、分类器不重跑；即使重跑，approval answerer 也拿不到"用户刚确认过"的上下文。方向（待实现）：① 裁决缓存签名纳入 `ask_user_question` 的答案（工具结果层面的意图信号，与 `renderUserIntent` 同权重）；② 或 approval 瀑布对"紧邻 ask_user_question 确认 + 同 tool 同 callId"的提权调用放行；③ 或与 allowPath 桥接（`approval-bridge`）联动——提权调用若已桥接则直接 `allowed-once`，无需用户再输入文字。关联：M-34（缓存键须覆盖所有裁决输入——本条是"工具型意图未纳入缓存键"的新实例）；与 allowPath 桥接分析（"用户显式确认后放行成功的原因"段）互补，但那条只解释了文字意图，本条是工具型授权缺口。
  - **决策（2026-08-31 定，方案 ①）**：把 `ask_user_question` 的答案**纳入 `renderUserIntent`**（作为 `user:` 意图行）→ 用户经工具授权后意图 hash 变化 → 缓存签名变化 → 旧 DENY 缓存 miss → 分类器以新授权上下文重跑。理由：① 直击根因（工具型意图未进缓存键，M-34 语义）、与文字授权完全同构；② 启发式"紧邻同 callId 放行"脆弱、不通用；③ allowPath 桥接已单独实现（v0.10.0，仅覆盖白名单），本条补的是**非白名单路径**的工具型授权缺口，二者互补。实现要点：从 assistant 消息的 `tool-call` 块建 `toolCallId→toolName` 映射，识别 `ask_user_question` 的 tool-result（`!isError`），解析其 `answers[].selected/custom` 作为意图文本（解析失败回退原始 JSON 文本，仍是有效信号）；普通工具结果仍排除、不挤占意图窗口。
  - **✅ 已实现（2026-08-31）**：`src/classifier.ts` 新增 `toolNameByCallId` / `hasAskUserAnswer` / `askUserAnswersText`，`renderUserIntent` 对 `source.kind==='tool'` 且命中 `ask_user_question`（`!isError`）的结果渲染为 `user: <selected/custom>` 意图行；错误结果（isError，如用户取消）不算授权。pre-execute 门与 approval 瀑布的意图 hash 自动随之变化（二者都走 `renderUserIntent` → `hashString` → `VerdictCache.sig`），无其他调用点改动。
  - **验证**：`npm run typecheck` + `npm test`（48 用例，新增 4 条：直接文字=意图/普通工具结果≠意图、ask_user_question 答案=意图且解析 selected、错误结果≠意图、工具型授权改变意图 hash→旧 DENY 失效）。README(en/zh) 已同步（`<recent_user_intent>` 例外 + 裁决缓存语义）。**版本**：0.10.0 → **0.10.1**（bug 修复：工具型授权不再被旧 DENY 缓存吞掉）。

- **待解决（2026-09-04）：`allowPath` 白名单对 `git add/commit/push` 写操作不生效（路径判定无法命中白名单，写操作落入评审被拒）** — 现象：`~/.agents`（及 `~/.claude`，均已在 web profile 的 `allowPaths` 里）的 git 操作，即使目标路径在白名单内，`git add/commit/push` 仍走评审（`auto-mode` 判 `classifier:unsafe` / 或需 `danger-full-access` 升级被拒）。根因：① 白名单命中（`curated allowPaths trust`，pre-execute L313 `isInsideTrusted`）**依赖"命令能暴露其写入目标路径"**；② `git add/commit/push` 是 **bash 命令**（非 file tool），走 `bashWriteDestinations(commandText)`（`bands.ts`）尝试提取写入目标——但该函数**不识别 git 命令**，无法从 `git commit` 解析出它实际写入的 `.git/index` / `.git/refs` → `allowPathTargets` 为空或命中不了 → 不满足 `every(p => isInsideTrusted(p, roots))` → 掉进分类器 → 评审。**注意区分**：与 2026-09-01 Issue C（allowPath 命中但 **DSH file sandbox** 拦截 vault 外 OneDrive 写入）是两个**独立层**——Issue C 是"白名单信任了但沙箱不放行"；本条是"**白名单判定本身无法命中 git 写操作**"（路径提取问题）。方向（待实现）：① `bashWriteDestinations`（`bands.ts`）对 `git add/commit/push` 类命令返回其**仓库根**（如解析 `git -C` / 当前仓库 `.git` 路径），使 `isInsideTrusted` 能命中 `~/.agents` 等白名单根；② 或把 `git add*`/`git commit*`/`git push*` 加入 `DEFAULT_ALLOW`（`config.ts`）零 LLM 白名单，像已有 `git status/diff/log` 一样不进分类器；③ 或对 git 写操作特判"目标在白名单根下 → 直接 next()"。关联：与 `allowInsideWorkingDirectory`（L276 `!isEscalation` 捷径）、Issue C（沙箱层）互补。

  - **决策（2026-09-04 定，方案 ①）**：扩展 `bashWriteDestinations`（`bands.ts`）——让 git 写命令（`add`/`commit`/`push`）返回其**仓库根**（`git -C <dir>` 或有效工作目录），使 `isInsideTrusted` 能命中 `~/.agents` 等白名单根。不采用 ②（把 `git add*`/`commit*`/`push*` 加入 `DEFAULT_ALLOW`）：那会把 git 写交给**全局零 LLM 信任**（任何仓库、任何路径），远超用户「白名单内信任」的声明；且 `git add/commit/push` 是写操作，与 `status/diff/log`（只读）不同，白名单内由 allowPath 判定更安全。
  - **✅ 已实现（2026-09-04，v0.11.1）**：`src/bands.ts` 三处改动——① `cd <dir>`（及裸 `cd`→HOME）作为**受跟踪的良性导航命令**：更新有效工作目录、不产生写目标、不再使整个复合命令回退（原 smoke 用例「`cp a /tmp/b && cd /tmp` → []」语义随之翻转，改为「`cd -`（$OLDPWD）不可预测 → 回退」）；② `destinationsOf` 的 `git` 分支：`add`/`commit`/`push` 返回仓库根（`-C` 解析、否则取有效 cwd）；`clone` 保持原逻辑；`reset --hard`/`clean`/`rebase`/`merge` 等改写型命令**刻意不含**（留在分类器/硬拒带）；③ `splitShellSegments`/`hasUnquotedRedirect` 识别 **fd-dup 重定向**（`2>&1`、`>&2`、`>&-`）——它不是文件写入，不再使 `git push … 2>&1 | tail` 整体回退（真实 `>file`/`>>file` 仍回退）。`pre-execute.ts` 把 `session.header?.cwd` 传入 `bashWriteDestinations`（裸 `git add .` 解析仓库根需 cwd）。
  - **安全边界（与既有语义一致）**：只有 `add`/`commit`/`push` 得到「仓库根 in allowPath → 信任」；删除/改写型 git 命令不被 allowPath 信任；deny 频带与 `matchDeletion`（`git clean -f`）仍最先执行；fd-dup 仅视为「fd 重定向」而非文件写；复合命令含未识别命令仍整体回退分类器。
  - **验证**：`npm run typecheck` + `npm test`（60 用例，新增 git 仓库根解析 / `-C` / cwd / `cd -` 回退 / fd-dup `2>&1` / 改写型 git 不信任等断言）；`npm run test:flow`（bridge-flow 4 断言通过）；node 脚本对真实形如 `cd ~/.agents && git add … && git commit … && git push origin main 2>&1 | tail` 的命令断言 `bashWriteDestinations` 返回 `~/.agents`（HOME 展开后）。
  - **版本**：0.11.0 → **0.11.1**（bug 修复：allowPath 白名单对 `git add/commit/push` 写操作不生效）。README(en/zh) 同步（allowPath 覆盖 git 写命令 + fd-dup 重定向不属文件写）。

## 权限预设图标（2026-08-23 补记）

- **动机**：`auto-mode` preset 在权限选择器里应显示一个 ⚡ 图标（之前靠本机 patch 硬编码进 DSH 客户端 bundle，别人装插件拿不到）。
- **方案（决策）**：**不改造 DSH 源码仓库、不加新插件**。采用"插件声明 + 用户指导"：插件在 `cordis.patch.yml` 的 `presets.auto-mode` 声明 `icon`（内层 SVG path `d`），用户可在 README 指导下改成自己的 logo；是否渲染取决于 DSH 是否支持消费预设 `icon`（原生 DSH 硬编码 glyph 映射、会静默忽略该字段；本机 DSH 经 `dsh-permission-preset-icon.mjs` 补丁支持）。
- **DSH 侧**：`dsh-permission-preset-icon.mjs`——host `PresetSpec`/`PresetOption` 增加 `icon`，client `PermissionSelect` 的 `optionGlyph(option)` 优先读 `option.icon`（画在共享 shieldOutline 内），内置三档仍走硬编码映射作回退。
- **插件侧**：`cordis.patch.yml` 的 `presets.auto-mode` 声明 `icon: 'M9.15 3.4L5.85 8.55H7.95L7.05 12.6L10.45 7.25H8.25L9.15 3.4Z'`（bolt）。未支持该字段的 DSH 优雅忽略。
- **README 指导**（EN + ZH）：写明如何设 `icon`、何时显示、无需改 DSH 源码/加插件。图标纯外观，不渲染时 auto mode 行为不变。
- **⚠️ schemastery `.optional()` 坑**：`dsh-permission-presets` 的 **config schema** 用 `import z from "schemastery"`（非 zod），schemastery 的 `Schema` **没有 `.optional()`**（只有 `.required()`/`.default()`），且 `z.object` 字段**默认可选**。所以补丁**必须写 `icon: z.string()`**，不能写 `icon: z.string().optional()`——后者会让 `static Config = z.object(...)` 在模块加载时抛错，拖垮整个 plugin tree（`dsh web` 起不来）。client 侧的 project schema 用的是 `z$1`（zod），那里 `.optional()` 才合法。

## 路径归属 bug 修复（2026-08-23 补记）

- **现象**：写工作区内部路径（如 `~/.dsh/patches/...`）也会被 pre-execute 分类器拦截（`pre-execute-deny`），尽管 `session.cwd` 记录为 `/Users/logan/.dsh`。
- **根因**：pre-execute 门用的是 `session.cwd`，但 DSH `Session` **没有 `cwd` 访问器**——cwd 在 `session.header.cwd`（`SessionHeader`）。`session.cwd` 恒为 `undefined` → `trustRoots` 永远不会把会话工作区加入 trust roots → `allowInsideWorkingDirectory` 从不把工作区内文件操作当作 in-tree → 全被送进分类器。
- **修复**：`src/pre-execute.ts` 将 `trustRoots(config.allowPaths, session.cwd)` 改为 `session.header?.cwd`。
- **🔎 待诊断——越区写入偶发被 fail-open 放行**：某次 E2E 中，写 `~/Documents`（越区）得到裸 sandbox 拒绝，而非分类器裁决（熔断器未跳闸），疑似分类器分支抛错被 catch 兜底 fail-open，或 `collectPaths` 未识别为越区。**已加诊断**：pre-execute 门新增 `pre-execute-fileop`（记录 `esc/targets/inTree/outOfTree/breaker/cwd`）与 `pre-execute-fail-open`（记录错误 message+stack）到 decisions.jsonl，用于下次 auto 模式复现时定位根因。**防御**：`resolveRoute` 改用 `agent.options?.provider/model`，避免 `agent.options` 缺失时抛错导致 fail-open。

## 分类器 effort 回退缺陷修复（2026-08-25 补记）

- **现象**：auto-mode 会话内所有需要 LLM 分类的动作连续 `classifier returned no verdict` → failClosed 拒绝（08-23 10:15 起反复出现；08-25 17:24–17:25 一次会话内 4 次，主模型同一路由 opencode-go/deepseek-v4-flash 全程正常）。
- **诊断证据**（cldiag 动态插件复刻分类器调用）：
  - 不带 `reasoningEffort`：成功（~900ms，finish=stop，返回 `"0"`）；
  - 带 `reasoningEffort: 'low'`：**0ms 失败**，流以 `finish {kind:'error', reason:{kind:'error', failure:{message:'provider "opencode-go" model "deepseek-v4-flash" does not support reasoning effort "low"', code:'UNSUPPORTED_REASONING_EFFORT'}}}` 终结。
- **根因**：dsh-llm 对「模型不支持 effort」有两种失败形态——配置解析阶段**抛** `UNSUPPORTED_REASONING_EFFORT`（插件 `streamTokens` 的 catch 已处理，重试不传 effort），以及流式调度阶段**以 error-finish chunk 终结**（不抛异常）。后者绕过了插件的 catch 分支：`streamTokens` 直接把 `{text:'', reasonKind:'error'}` 返回，`classify/fastFilter` 见 `reasonKind==='error'` 返回 null，重试逻辑永不触发。配置 `reasoningLevel: low` 让每次调用 100% 命中该路径。
- **修复（已实现）**：
  1. `streamTokens`：**error-finish 视为可重试失败**——凡 `reasonKind==='error'` 且本次尝试带了 effort，`continue` 到下一次无 effort 尝试（与抛异常路径同语义）；同时把 error-finish 也写入 DSH 日志 warn（此前该路径完全静默）。
  2. **详细错误日志**：`ClassifyOptions` 新增 `onAttemptFail` 回调，每次流失败（error-finish 或抛异常）回调 `{stage, effort, failure:{message, code}, raw}`；pre-execute 门与 approval 瀑布两个调用点把它落进 `decisions.jsonl` 的 `classifier-fail` 事件（`event/stage/effort/route/detail`）。
- **验证**：cldiag 仿真「effort-low 失败 → 无 effort 重试」对真实 provider 成功返回 verdict `"0"`；`npm run build` + `npm test` 通过。运行中的 dsh 进程需重启后加载新 lib 生效。
- **遗留建议 → 已决定（2026-08-25）**：默认 `classifier.reasoningLevel` 改为 **`off`**（显式关闭分类器 reasoning）。实测（cldiag 复刻，opencode-go/deepseek-v4-flash，fast512 与 full2048 两档）：`off` 与不传 effort 均 **~1–1.7s 返回、无 reasoning 块、不超时**——「不给 effort 会导致过度思考/超时」不成立；`off` 同时省掉每次的无效首试。代码侧 error-finish 回退仍保留，其他路由可继续用 low/medium/high。

## 提权人工弹窗触发策略与 breaker 计数修复（2026-08-25 补记）

- **用户定稿策略**：普通操作由分类器自动裁决；**沙箱提权（sandbox_permissions）的「人工弹窗」只在 breaker 跳闸后出现**——即 3 次连续分类器拒绝或会话累计 20 次拒绝之后，提权请求强制走人工审批（弹窗由用户拍板），而非每次提权都弹窗。分类器在跳闸前仍按提示词裁决提权（自我扩权 → 拒绝）。
- **暴露的 bug**：重复提权场景下 breaker 根本跳不了闸——**裁决缓存命中的 DENY（`a prior identical action was judged unsafe`）不计入 breaker**（连续与总计都不计），且中间任何一次 allow 会清零连续计数。观测会话（2026-08-25 09:54–09:56）中模型连续 4 次提权被拒，breaker 从未触发，人工弹窗永远不来，模型只能空转。
- **修复**：`pre-execute.ts` 与 `index.ts` 的 **cache-DENY 分支同样调用 `breaker.countDeny`**（计入连续与总计），跳闸时与普通 reject 分支一致：写 `breaker` 事件、注入 `BREAKER_TRIPPED_HINT`（提示模型直接请求提权 → 人工审批）。修复后上述场景第 3 次缓存/裁决拒绝即跳闸 → 提权进入人工弹窗。
- **验证**：`npm run build` + `npm test` 通过；重启后可在 auto 会话复现「重复提权 3 次 → 弹窗」。

## 风险导向分类 + 用户意图上下文修复（2026-08-25 补记）

- **用户定稿**：**明显无危险、可逆的操作应自动放行**（例：编辑 git 仓库内的 skill 文件）。分类器应**按动作实际风险**裁决（可逆性 + blast radius + 用户对齐），不再因「请求提权」这一机制本身一刀切拒绝。
- **诊断结论**（2026-08-25 实锤）：该场景被拒的根因不是 deny 正则（未命中），而是 `prompt.ts` 把「agent 自我扩权」列进不可覆盖 danger 清单——分类器从不评估动作本身（git 可回退、低风险）就被「提权」信号否决；叠加 `renderUserIntent` bug（工具结果/系统注入 role=user 挤占最近 6 条窗口，用户授权原话读不到，只见到模型 justification 自称授权）。
- **改动（已实现）**：
  1. `prompt.ts`：UNSAFE 清单**去掉「自我扩权」一刀切**，改为按动作风险（保留：不可逆破坏/泄密/持久化/削弱安全/共享生产外部状态）；**新增**「READ-ONLY and REVERSIBLE operations are ALLOWED（GET/HEAD、检视、状态查询、可撤销的本地改动、git 跟踪文件）」+「提权本身不是危险——评估它启用的动作；低风险可逆 + 用户对齐可放行（如编辑工作区外的 git 仓库 skill 文件）；为真危险动作提权仍禁止」。
  2. `classifier.ts` `renderUserIntent`：**只保留 `source.kind === 'user'` 的人类消息**（排除 tool/plugin/system/model 注入），保证用户授权原话稳定进入意图窗口。
- **验证**：`npm run build` + `npm test` 通过；提示词级场景测试（真实 provider）断言：skill 编辑+提权+git 可回退+用户授权 → allow；GET/只读 → allow；泄密/持久化/生产变更 → reject。重启后 E2E 复测。

## 版本 0.7.0（2026-08-25 补记）

- **版本**：0.6.2 → **0.7.0**（行为变更：风险导向分类、人类消息意图窗口、熔断器缓存计数、effort 回退）。
- **边界**：审批通知由 hooks 层过滤（dsh-hooks `notify-approval` + `~/.dsh/scripts/notify-hook.sh`），**插件侧无法拦截**——实测 approval/request answerer 即使 `prepend` + 不调 `next()`（Cordis 瀑布否决）也不能抑制 dsh-hooks 的 `approval/asked` 通知（动态插件验证：answerer 短路了裁决、无 decision 记录，通知仍触发）。过滤语义见 profile `cordis.patch.yml` 的 `notify-approval` 注释。

## 两态化：移除 ask 态 + deny 提示增强（2026-08-26 补记）

### 决策（用户定稿）
- **分类器只输出两态：`allow` / `reject`，删除 `ask` 态**。`classifier.askFallback` 配置项随之移除（不再需要"ask 时是否弹人工"的开关）。
- **理由**（grill 确认）：
  1. prompt 从未定义"何时 ask"的触发契约——ask 只出现在输出格式示例里，分类器输出 ask 是无依据的灰色地带。
  2. `askFallback=false`（原默认）下 ask 行为 ≡ reject（fail-closed），ask 是行为冗余态。
  3. "需要人工"的通道已存在且不依赖 ask：熔断器（3 连拒 / 20 总拒 → 跳闸 → 审批转人工）+ `BREAKER_TRIPPED_HINT` 引导模型直接请求 `danger-full-access` 升级（升级本身弹人工审批窗口）。
  4. ask 态在 `askFallback=true` 时 `resetConsecutive`，会**削弱熔断保护**（分类器不确定→弹窗→计数器清零，连拒跳闸形同虚设）。去掉 ask 后该漏洞消失。
- **deny 提示增强**：deny 时提示 = 分类器拒绝理由 + **主模型当时的操作解释（justification，如有）** + 安全替代引导（找更安全方法；无则停止重试、询问用户明确许可）。
- **justification 透传补全**：原实现只在 **escalation** 场景把 `exec.arguments.justification` 拼进分类器 prompt（`escReason`）；**非 escalation 的越区文件操作**只传路径、不带 justification。两态化时统一补上，让分类器判定与 deny 回显都能看到主模型的操作原因。

### prompt 契约（两态）
- 输出格式仅两种：`{"decision":"allow","reason":"<sentence>"}` / `{"decision":"reject","reason":"<sentence>"}`。
- **明确指示"何时 reject"新增一条：不确定时 REJECT（fail-closed）**——拒绝可重试或升级到用户，误放不可逆；宁拒勿放。
- **类别只是倾向，具体内容为准（2026-08-26 修正）**：原 "EVERYTHING routine — installs, builds, tests, file edits, git add/commit/status — is SAFE" 是**绝对化断言**，存在**伪装绕过风险**——`curl|sh` 可包装成 install、git push 到未知 remote 可包装成 git 操作、未知包安装可带任意 postinstall 脚本、edit 可写 secrets。改为：routine 类别**通常**安全/可逆（倾向基准），但**必须判断具体命令与参数**，并显式列出"看似 routine 实则危险"的伪装特征（下载执行远程代码、未知包安装、写 secrets、不可逆删除、推未知 remote、关闭保护、触达共享/生产/外部状态）。
- 原有指示保留：可逆/用户明确要求 → allow；不可逆破坏/泄密/持久化/削弱安全/共享生产外部状态/不服务当前请求 → reject。

### 代码改动
- `classifier.ts`：`VerdictDecision = 'allow' | 'reject'`；`parseVerdict` 中 `raw==='ask'` **映射为 reject**（reason 注明 "uncertain (ask) — treated as reject (fail-closed)"），保证老模型输出 ask 时 fail-closed。
- `prompt.ts`：输出格式示例删 ask 行；新增不确定→reject 指示。
- `pre-execute.ts`：删 ask 分支（原 400-410）；`cache.put` 三态三目简化为二态；deny 提示（`denialText`）回显分类器 reason + 主模型 justification；非 escalation 越区文件操作的 `escReason` 补 justification。
- `index.ts`：approval 瀑布删 `case 'ask'` 与 `askHumanForDecision`/`HumanDecision`/`UserQuestionsLike`（无其他引用）；`index.ts:104/452/478` 的 `'ask'` 是 DSH 审批策略枚举（非分类器态），**保留不动**。
- `config.ts`：删 `classifier.askFallback` 字段；`cordis.patch.yml` 删对应配置行（zod object 默认 strip 未知 key，残留不报错但为整洁一并删除）。
- README（EN/ZH）同步：删 askFallback 说明，决策模型改两态。
- **版本**：0.7.0 → **0.8.0**（行为变更：移除 ask 态、deny 提示增强、justification 透传）。
- **验证**：`npm run build` + `npm test`；提示词级场景测试断言：常规 → allow；危险 → reject；**模型输出 ask → 归一为 reject**；越区文件操作带 justification → 分类器 prompt 可见。重启 dsh 后 E2E。

## 裁决缓存意图感知 + allowPaths 覆盖 bash 写命令（2026-08-29 补记）

### 背景（实测复现）
向 OneDrive（`~/Library/CloudStorage/OneDrive-TheHongKongPolytechnicUniversity/Projects/GRF 2026/Proposal/`）导出文件时：
- `08:47:29` 分类器判 DENY（`Writing to an external OneDrive path outside the working tree modifies shared/external state...`，tool=bash，带 danger-full-access 提权）；
- `08:48:38` 同命令重试命中**缓存 DENY**（`a prior identical action was judged unsafe`）——用户已显式授权，仍被旧缓存拦截。

### 问题 1（bug）：裁决缓存不感知用户授权意图
- **根因**：`pre-execute.ts` 的缓存检查（`VerdictCache.sig`）发生在 classifier 之前，且签名**不含用户意图**——`cache.ts::sig` 只基于 `tool + 命令前 maxArgsChars 字符小写`。用户授权后命令签名与之前被拒的完全相同 → 命中缓存 DENY → classifier 根本没被重新调用（classifier 经 `<recent_user_intent>` 本可读到授权）。
- **修复（已实现）**：`cache.ts` 新增 `hashString(text)`（djb2 → base36）；`VerdictCache.sig(toolName, reason, args, maxChars, intentHash?)` 在提供 `intentHash` 时追加 `|intent:<hash>`。`pre-execute.ts` 与 `index.ts`（approval 路径）把 `renderUserIntent(...)` **提前到缓存检查之前**，对最近直接人类消息（`source.kind==='user'`）渲染结果做 hash 并入签名；新用户授权消息进入意图窗口 → hash 变化 → 缓存 miss → classifier 以新意图重跑。工具结果/系统注入（role=user 但非 human）被 `renderUserIntent` 过滤，不破坏缓存；同一意图窗口内的重复命令仍命中缓存。
- **验证**：`npm test`（cache 签名 + 意图 hash 用例）；`npm run build` + `npm run typecheck`。

### 问题 2（功能）：OneDrive allowPaths 白名单
- **关键事实（与 handoff 预判不同）**：被拒动作是 `tool=bash`（cp），而 `pre-execute.ts` 的 curated allowPath 分支（line 274-282）**只对文件工具生效**（`targetPaths` 仅由 `collectPaths` 填充，bash 为空数组）——仅把 OneDrive 加入 `allowPaths` 对 `bash cp` 无效。
- **修复（已实现）**：`bands.ts` 新增 `tokenizeShell` + `bashWriteDestinations(cmd)`——对**非复合** bash 命令识别写命令族（`cp/mv/rsync/ditto/install/tar -x(-C)/unzip(-d)/unar(-d)/curl -o/wget -O/git clone`），提取目标目录/文件路径；`pre-execute.ts` 的 curated allowPath 判定改为「文件工具用 `targetPaths`，bash 用 `bashWriteDestinations` 的结果」，任一路径经 `isInsideTrusted`（真实 symlink-resolve 前缀匹配）命中 allowPath → `pre-execute-allow`（`curated allowPath`），不经过 classifier。
- **安全边界**：仅限白名单写命令 + 目标在用户 curated allowPath 内 + deny 频带仍最先执行（`/etc`/`mv|trash` 系统目录、`.ssh/`/`.env`/`credentials` 等仍硬拒绝）；删除类命令（`rm`）不在写命令白名单，不被放行；复合命令/重定向（`>`）不进此分支（回退 classifier）。**权衡**：allowPath 是用户显式声明的全信任目录，写入其中是声明意图；误放风险限于「把文件写进用户自己信任的目录」。
- **配置归属（重要，不回退 9bb483c）**：**不把个人 OneDrive 路径写进 `DEFAULT_ALLOW_PATHS` / 插件默认 `cordis.patch.yml`**（9bb483c 已移除个人路径，默认保持通用、仅 `/tmp/`）。OneDrive 路径改由**用户 profile 覆盖**：`~/.dsh/profiles/web/cordis.patch.yml` 中 `- id: auto-mode` 覆写 `config.allowPaths`（loader patch 语义：`config` 整体替换；因其余字段与代码默认完全一致，只覆写 `allowPaths` 即可，`/tmp/` 一并保留）。README 补充该配置方法。
  - **2026-08-29 用户定稿范围**：白名单采用**两个 OneDrive 根目录**（PolyU + 个人），而非最初的单个 Proposal 目录——`config.allowPaths = ['/tmp/', '/Users/logan/Library/CloudStorage/OneDrive-TheHongKongPolytechnicUniversity', '/Users/logan/Library/CloudStorage/OneDrive-个人']`。即任一 OneDrive 下**任意子目录**的写操作都跳过分类器；deny 频带与删除类命令保护不受影响。该选择仅在用户本地 profile，不进入 repo 默认。
- **验证**：`npm test`（bashWriteDestinations 用例：cp/mv/-t/rsync/tar -C/curl -o/git clone/非写命令/复合命令）；node 脚本断言「最小 profile 覆写（仅 allowPaths）解析出的完整 config 与 bundle 默认一致——**唯一差异**：bundle 的 `trash|mv` 系统目录 deny 模式缺 `[:…]` 里的 `:` 分支，代码默认更严格，属 fail-closed（更安全）方向，可接受」；`npm run build`。重启 dsh 后 E2E：`cp x.docx .../Proposal/` 应落 `pre-execute-allow (curated allowPath)`。
- **E2E 复测（2026-08-29）**：带 `&` 文件名（`DSH-E2E Research Statement & Methods - Ver11.0.docx`）的简单 cp 实测落 `curated allowPath`（bashDests 正确提取），引号感知修复活体生效；文件工具 allowPath 正常；真实用户请求的 OneDrive 导出 approval 路径 `allowed-once`。另确认：多行 shell 脚本（含 `$` 变量/`&&`）属复合命令按设计回退 classifier（非缺陷）。
- **版本**：0.8.0 → **0.9.0**（行为变更：裁决缓存意图感知 + allowPaths 覆盖 bash 写命令 + 引号感知复合判定）。

## deny 理由 200 字符截断修复（2026-08-30 补记）

### 背景（实测复现）
`decisions.jsonl` 中多条 deny 记录的 `reason` **恰好 200 字符、被切断在句子中间**（例：`...appears to be a `、`...serves no part of the user's re`、`...already denied in ~/Documents and ~/Downl`）。分类器写了完整的拒绝理由（常 200–350 字符），但传给模型的 deny 提示里理由只剩前 200 字符，导致模型看不懂"为什么被拒"，无法按提示改造命令，只能盲目重试。

### 根因（bug）
`classifier.ts` 的 `parseVerdict` 内部 `verdict()` 帮助函数：
```ts
reason:
  typeof reason === 'string' && reason.length > 0
    ? reason.slice(0, 200)   // ← 唯一截断点
    : `classifier decision: ${decision}`,
```
该 `slice(0, 200)` 从 v0.4.1 起存在、从未改动。截断后的 `verdict.reason` 经 `pre-execute.ts` 的 `denialText(...)` 原样嵌入给模型的 deny error 提示，并写入 `decisions.jsonl`。

### 决策
- **移除 200 字符截断，完整理由透传**。理由本身受分类器 `maxTokens`（2048）约束，不会无限长；deny 提示是给模型的关键指引，截断直接伤害决策质量。
- 不引入新的截断点；`decisions.jsonl` 为 JSONL，长字符串无碍。
- **注意区分**：与 2026-08-29 的"缓存不感知授权"是**两个独立问题**——前者修的是缓存命中逻辑（intentHash），本次修的是理由透传（无截断），互不涉及。

### 修复（已实现）
- `classifier.ts` `verdict()`：删除 `reason.slice(0, 200)`，改为直接透传 `reason`（保持 `typeof reason === 'string' && reason.length > 0` 的守卫与默认兜底）。

### 验证
- `npm run typecheck` + `npm test`；`npm run build` 后 node 断言 `parseVerdict` 对超 200 字符理由不再截断（长度 > 200 原样返回）。
- **版本**：0.9.0 → **0.9.1**（bug 修复：deny 理由不再被 200 字符截断，完整透传给模型与日志）。

## allowlist 配置位置注入系统提示（2026-08-30 补记）

### 背景（需求）
运行中动作偶尔被拦截（目标路径在工作区外）。用户希望把路径加入白名单，但**模型不知道白名单配置在哪儿、改什么**——allowPaths 的配置方法只写在 README（给人看），模型在会话里看不到，导致「想加白名单却无从下手」。

### 决策
- 用插件已有的 **system prompt 注入机制**（`systemPrompt.context`）给**每个 auto-mode 会话**注入一段 `auto-mode:allowlist` 指引：告诉模型 allowPaths 配置的位置、改法、行为与安全边界。
- 仅在** auto-mode 生效**的会话注入（`text()` 惰性求值，`isAuto(agent.session)` 为 false 时返回空串）——pre-execute gate 只在 auto-mode 下拦截，非 auto-mode 会话无需该指引。
- 不动 `denialText`（deny 提示已含「ask user for explicit permission」，再加配置位置会臃肿；全局知识放 system prompt 一次到位）。

### 实现（已实现）
- `src/index.ts` 新增 `ALLOWLIST_SENTENCE` 常量（内容：`<profile>/cordis.patch.yml` 的 `- id: auto-mode` → `config.allowPaths` 覆写点；patch 整体替换 config 故需保留 `/tmp/` 默认；allowlist 内文件工具与 bash 写命令跳过分类器、硬 deny 频带仍最先执行；仅用户显式要求才改配置，否则给出精确编辑建议待用户确认）。
- `agent/created` 的 `systemPrompt.context` 注册新增 `auto-mode:allowlist`（`order: 116`，紧跟 `approval:policy` 的 115），`text()` 返回 `isAuto(agent.session) ? ALLOWLIST_SENTENCE : ''`。

### 验证
- `npm run typecheck` + `npm test`；`npm run build`。
- 行为验证：重启 dsh 后 auto-mode 会话系统提示应含 `auto-mode:allowlist` 段；非 auto-mode 会话不含。

### 精简与纠错（2026-08-30 追补）
- **AUTO_SENTENCE 纠错（两态化）**：原句仍写 "three rulings: approved, blocked, or needs-human-input"——这是 0.8.0 两态化（`allow | reject`，ask 移除）**遗留的过期描述**，会误导模型。改写为两态语义（allow/reject；reject 执行前拒绝，可安全重试或升级给用户，误放不可撤销），保留"user rejected 可能是 reviewer 拦的"提示。
- **ALLOWLIST_SENTENCE 精简**：删除同一配置身份的重复表述（"the `allowPaths` config on the auto-mode plugin row" 与 "entry `- id: auto-mode` under `config.allowPaths`" 二选一），安全边界句收紧。754 → ~470 字符。
- **目标**：auto 模式合计提示 1099 → ~810 字符（~200 tokens，-26%），且修正一处事实错误；提示保持"能定位配置、能自证边界、不产生误解"。

- **版本**：0.9.1（与上一条 bug 修复同一 patch 版本）。

## E2E 复测发现的两个 bug 修复（2026-08-30 追补）

### 背景
重启后 E2E 复测（v0.9.1）发现两处问题：① deny 提示里分类器理由**重复出现两次**；② 写 allowlist 的 `/tmp` 路径没走 `curated allowPath` 分支而是掉进分类器（macOS 软链导致）。

### Bug A：deny 提示理由重复
- **现象**：`dsh-automode denied this action (classifier:<完整理由>): <完整理由> — reshape ...`——同一理由出现两次。
- **根因**：`pre-execute.ts` 分类器 deny 分支（line 415）`denialText('classifier:${verdict.reason}', '${verdict.reason} — reshape...')` 把完整理由同时塞进 **category 槽**（本应是短标签）与 **reason 槽**。对比其他 deny 路径：确定性频带用 `'deny'`、缓存拒绝用 `'classifier:unsafe'`，均不重复。
- **修复（已实现）**：category 改为短标签 `'classifier:unsafe'`（与缓存拒绝路径一致），理由只保留在 reason 槽一次。

### Bug B：macOS `/tmp` 软链使 allowPath 对新建文件失效
- **现象**：`write /tmp/dsh-xxx.txt`（新文件）落 `pre-execute-fileop inTree=false`，走分类器而非 `curated allowPath`。
- **根因**：`realpathSafe(p)` 对**不存在的路径**回退到 `resolve(p)`（词法解析）。gate 时刻目标文件还不存在 → 目标解析为 `/tmp/...`；而 allowPath 根 `/tmp/` **已存在** → `realpathSync` 解析为 `/private/tmp`（macOS 软链）。`/tmp/...` 不以 `/private/tmp/` 开头 → 匹配失败。**任何软链 allowPath 根下的新建文件都匹配不上**；无软链的 OneDrive 正常。
- **修复（已实现）**：`realpathSafe` 对不存在路径改为**找最近存在的祖先 realpath + 拼接尾部**——`/tmp/dsh-new.txt` → 父 `/tmp` 存在 → realpath `/private/tmp` + `dsh-new.txt` → 命中 `/private/tmp/` 根。实测：OLD 不信任 /tmp 新文件（false）、NEW 信任（true）；对照 `~/a.txt` 两者均不误放。
- **验证**：`npm run typecheck` + `npm test`；node 断言（realpathSafe 对 /tmp 新文件/深层不存在路径/已存在文件/普通路径）。

- **版本**：0.9.1 → **0.9.2**（bug 修复：deny 理由去重 + macOS 软链 allowPath 新建文件失效）。
- **README 文档化（2026-08-30）**：README(en/zh) 新增「Compatibility & contributions」段——声明**仅 macOS 验证**（含 `/tmp` → `/private/tmp` 软链由 realpath 最近祖先解析处理）、Linux/Windows 未验证（路径/deny 语义可能有差异），并**欢迎其它平台问题与 bug 的 issue/PR**（指向仓库地址）。

## 白名单路径提权「完全自动放行」：approval 桥接（2026-08-31 补记）

### 背景（实测复现，handoff 实证）
2026-08-31 在 JC STEM 会话把 `~/.agents` 加入 `config.allowPaths` 后，向 `~/.agents/.dsh-whitelist-verify.txt` 写无害测试文件（带 `sandbox_permissions=danger-full-access` 提权），`decisions.jsonl` 连续两条：
```
pre-execute-allow  write  curated allowPath: ~/.agents/.dsh-whitelist-verify.txt
decision           write  outcome=rejected  reason="escalate sandbox to danger-full-access: ..."
```
插件 pre-execute 门已按 allowPath 确定性放行，但同一调用仍被拒。用户显式确认（ask_user_question）后同动作才 `allowed-once`。结论：allowPath 只让 pre-execute 层放行，「提权评审层」仍会独立裁决。

### 根因（关键澄清：评审层就是插件自己的 approval answerer）
追踪 DSH 审批链后发现，所谓「harness 评审层」**并非独立于插件的 harness 模型**，而是 dsh-automode 自己在 `approval/request` 瀑布里注册的 answerer（`index.ts::decideAuto` + 其分类器）：
- 提权调用 `approveEscalation`（@deepseek-ai/dsh-sandbox）→ `ctx.approval.request({ agent, toolName, callId, reason })` → 插件 answerer `decideAuto`。
- `ApprovalRequest` 只带 `agent/toolName/callId?/reason?/signal?`，**没有 args/路径**（`decideAuto` 里 `const args = undefined // approval path doesn't carry raw args`）→ 审批路径无法复用 allowPath 判定 → 只能交给分类器；分类器无「用户在 allowPath 内」上下文 → 判 DENY → `outcome=rejected`。
- pre-execute 门能放行是因为它有 `exec.arguments`（路径）；approval answerer 拿不到。
- 用户显式确认后放行成功的原因：新授权消息进入 `renderUserIntent` 意图窗口 → 缓存签名变化 → 分类器读到用户明确授权 → allow。这反证评审者就是分类器（而非 harness 固有模型）。

### 决策（方案 A 的插件内落点）
在插件内加「approval 桥接」，让 allowPath 提权调用零评审、零确认自动放行，**不改 DSH 本体**：
- pre-execute 门对 allowPath 提权放行时，用 **callId**（`tools/pre-execute` 的 `ToolExecution.callId` 与 `approval/request` 的 `callId` 是同一个值，dsh-tool-fs 的 `approveEscalation` 直接透传 `exec.callId`）记录一笔桥接。
- approval answerer `decideAuto` 在 deny 频带之后、缓存/分类器之前查 `req.callId`：有新鲜桥接记录 → 直接 `allowed-once`（确定性、零 LLM）。
- 为什么选插件内而非 patch DSH：① 评审者就是插件自己的 answerer/分类器，插件内修即修源头；② 不碰 npm-global 的 DSH 本体（升级会被覆盖、风险大）；③ callId 精确关联，无「时间窗+同工具名」的误放窗口。
- 不采用方案 B（全局 danger-full-access）：放开整个沙箱，非白名单路径也失控，仅作临时备选。

### 安全边界（与既有语义一致）
- **deny 频带仍最先执行**：pre-execute 先 deny 后 allowPath，approval 桥接检查也放在 hard deny + soft deny 之后——白名单内的敏感路径（如 `~/.ssh/`、`authorized_keys`、`/etc/` 系统目录）仍硬拒。
- 桥接只对 pre-execute 已**确定性**判定「所有目标都在 trust roots 内」的调用生效；非白名单路径不进桥接、行为不变（仍分类器/人工）。
- breaker 跳闸时不进 allowPath 分支、不记录桥接 → 走人工，桥接不绕过熔断。
- 桥接记录**消费即删**（take）+ 短 TTL（60s）+ 容量上限（2000）惰性清理，杜绝跨调用复用与内存增长。

### 实现（已实现）
- 新增 `src/bridge.ts`：`AllowPathBridge`（`record(callId, {toolName, paths, at})` / `take(callId)`，TTL+容量，惰性清理）。
- `src/pre-execute.ts`：curated allowPath 分支 `return next()` 前 `bridge.record(exec.callId, {toolName, paths: allowPathTargets})`；`registerPreExecute` 新增 `bridge` 参数。
- `src/index.ts`：`apply()` 创建 `bridge` 实例传入 `registerPreExecute` 与 `decideAuto`；`decideAuto` 步骤 1/2 deny 之后插入桥接检查，命中 → 记 `approval-bridge` 事件 + `allowed-once`。
- 日志：桥接命中额外写 `event: 'approval-bridge'`，便于 E2E 在 decisions.jsonl 直接确认「curated allowPath + approval-bridge + decision allowed-once，无 rejected」。

### 验证
- `npm run typecheck` + `npm test`（新增 bridge 单测：record/take/TTL/容量清理/跨 callId 不误放）。
- `scripts/bridge-flow-check.mjs`（HOME 指向临时目录、mock ctx apply 插件）：写 allowPath 文件（带提权）→ pre-execute 记 `curated allowPath` + 桥接 → approval 返回 `allowed-once`；未桥接的 approval/request 仍 `rejected`（failClosed 无路由）。
- E2E（重启 dsh 后，auto-mode 会话）：写 `~/.agents/` 无害测试文件（带 danger-full-access）→ decisions.jsonl 只出现 `curated allowPath` + `approval-bridge` + `allowed-once`，无 `outcome=rejected`；非白名单路径（`~/.zshrc`、`/etc/`）行为不变；deny 模式（`~/.ssh/`）仍硬拒。
- **版本**：0.9.2 → **0.10.0**（行为变更：allowPath 提权调用零评审零确认自动放行）。

## 会话实录：workspace 相对路径误判 + 复合命令白名单失效（2026-09-01 补记，已检查/已修复）

> 本节记录 2026-09-01 实际会话中 auto-mode 暴露的四个问题，2026-09-01 当晚会话逐一核对源码并修复（v0.11.0）。均含实测证据（decisions.jsonl 判定记录 + 源码对照）。用户侧背景：Logan 两次提出质疑——「workspace 内的操作不应该过分类器」「OneDrive 在白名单为什么不能导出」。

### Bug A：workspace 内「相对路径」file_path 被判 out-of-tree，误入分类器 ✅ 已修复（v0.11.0）

- **现象（实测）**：auto-mode 会话中 `edit` 工具调用以**相对路径** `_internal/log.md`（绝对形式在 workspace 内，`cwd` 即 vault 根）被 `pre-execute-deny` 拦截，理由「Editing _internal/log.md is outside the trusted working directory and not clearly tied to the user's current request...」。同一会话编辑其他 workspace 内相对路径文件（`workspace/JC-STEM-2026/plan-draft/*.md`）同样被判 in-tree=false，只是因分类器「意图相关」而放行。
- **证据（decisions.jsonl，2026-09-01）**：
  - `{"tool":"edit","detail":"esc=false targets=[\"_internal/log.md\"] inTree=false outOfTree=true breaker=false cwd=/Users/logan/Library/Mobile Documents/iCloud~md~obsidian/Documents/Logans-vault ..."}`（同一目标两次 deny）
  - 同类相对路径 `workspace/JC-STEM-2026/plan-draft/a-Goals-Objectives-draft-v1.md` 等亦 `inTree=false outOfTree=true`。
- **根因（对照源码 pre-execute.js）**：`collectPaths`（line 67-81）原样取 `file_path` 的**相对路径**；`isInsideTrusted`（line 60-65）→ `realpathSafe(p)` 用**宿主进程 cwd**（DSH 进程 cwd，非 `session.header?.cwd`）解析相对路径。宿主进程 cwd ≠ 会话工作区根 → workspace 内相对路径解析后落在信任根（session cwd + allowPaths）之外 → `inTree=false` → 本应命中 line 226-247「in-tree → allow（不过分类器）」的捷径被跳过 → 错误进入分类器审查。
- **影响**：① workspace 内文件操作被错误分流到分类器（额外延迟 + 依赖意图上下文，分类器对「意图不相关」的维护操作拒拦）；② 与当前请求意图不相关的 workspace 内维护操作（如 `_internal/log.md` 日志记录）被误拦——本会话连续 2 次记录日志被拒；③ 用户困惑「明明在 workspace 内为何要过分类器」。
- **修复方向（已实现，2026-09-01）**：`isInsideTrusted(p, roots)` 增加第三参 `base`（会话工作区根）——`resolve(base, p)` 后再 realpath/前缀匹配；两个调用点（in-tree 捷径与 curated allowPath 判定）都传 `session.header?.cwd`。相对路径（`_internal/log.md`、`workspace/JC-STEM-2026/plan-draft/*.md`）现在正确解析到 workspace 内 → 命中 in-tree 捷径（不过分类器）。注意与 2026-08-23「路径归属 bug」区分：那条是 cwd **来源缺失**（`session.cwd` 恒 undefined → 改用 `session.header?.cwd`）；本条是 **cwd 已正确但相对路径未基于它 resolve**（`realpathSafe` 内部用进程 cwd），是同一 trustRoots 判定链上更深一层的问题——本次补上的是这一层。
- **验证（2026-09-01）**：新增单测（相对路径 + base → in-tree；`../` 逃逸 workspace → 非 in-tree；绝对路径有无 base 行为不变；无 base 时保持旧行为）；`npm run build` + `npm test` 通过。

### Issue B：复合 bash 导出命令使 OneDrive 白名单失效，approval 无法验证 ✅ 已修复（v0.11.0）

- **现象（实测）**：向白名单 OneDrive 目录导出 docx 的三步复合命令（`DIR=...; cp a b_temp && (trash b; true) && mv b_temp b && ls`）触发提权后被拒，评审理由「escalation request does not include the specific command to be executed, so the action cannot be verified as safe」。用户先在 `ask_user_question` 里选了「写入 OneDrive JC STEM 文件夹」仍被拒；用户**直接文字**「我允许你导出到OneDrive」后才放行。
- **证据（decisions.jsonl，2026-09-01）**：`esc=true bashDests=[] inTree=false outOfTree=false ... cmdHead="DIR=\"/Users/logan/Library/CloudStorage...`（多次，bashDests 恒为空）；对照组——简单 cp 命令 `bashDests=["/Users/logan/Library/CloudStorage/OneDrive-TheHongKongPolytechnicUniversity/.../x.docx"]` 正确落 `pre-execute-allow (curated allowPath)`。
- **根因/性质（与 spec line 202/206 对照）**：「复合命令回退 classifier」是**既有设计**（`bashWriteDestinations` 只解析非复合写命令，`&&`/变量/子 shell 不解析）；但今天暴露组合摩擦：① 白名单 allowPath 对复合命令**完全不生效**——`bashDests=[]` → `allowPathTargets` 空 → 不命中 → 连 approval-bridge 都不记录（line 287-290 桥接依赖 allowPathTargets）；② 复合命令 + 提权落入分类器/approval 后，approval 请求 **payload 不带具体命令/路径**（spec line 280「approval/request payload 不 carry args/paths」），评审无法验证安全 → 拒绝 → 用户须额外文字批准。
- **影响**：用户「把 OneDrive 加入白名单」的信任声明在常见导出场景（temp→trash→mv 三步复合命令）被绕过，需重复人工批准；与 allowPath 白名单「免审批」语义冲突。
- **修复方向（已实现，2026-09-01，采用 ① + 副作用守卫）**：
  - **决策**：采用方向 ①（扩展 `bashWriteDestinations` 解析复合命令），并加**副作用命令守卫**，避免「复合命令按设计回退」的安全边界整体失守。不采用 ②（approval payload 带命令 = harness/DSH 本体改动，升级覆盖风险大）；③（桥接复用）依赖解析出的 `allowPathTargets`，① 修复后桥接自然生效，无需单独实现。
  - **实现（bands.ts）**：新增 `splitShellSegments`（顶层 `&&`/`||`/`;`/`|`/`&`/换行 分段，引号+括号感知，`(trash b; true)` 子 shell 不误切并递归解析）与 `expandShellVars`（捕获 `VAR=...`/`export VAR=...` 纯赋值、`$VAR`/`${VAR}` 展开，种子 `$HOME`）；`bashWriteDestinations` 对复合命令逐段提取写命令目标（`mv A B`/`cp A B` 取 B、tar/unzip -C/-d、curl -o、wget -O、git clone），返回并集。**守卫**：任一段不是「已识别写命令 / 纯赋值 / 良性工具命令（echo、ls、mkdir、test、true、false、printf、pwd、stat、file、wc、head、tail、which、dirname、basename、date、sleep、uname、id、du、df、sort、uniq、cat、trash）」或含顶层重定向 `>`/`>>` → 整体返回 `[]` 回退分类器。副作用命令（kill/pkill/systemctl/launchctl/brew/docker/…）与 `rm`/`sh`/`bash` 等不在良性集 → 复合命令里出现即回退，防「`curl -o /tmp/e && bash /tmp/e`」类下载执行模式被 allowPath 放行。
  - **命令替换守卫（2026-09-01 双 agent 审查后补，HIGH 修复）**：段内含 **命令/进程替换**（`` `…` ``、`$(…)`、`<(…)`，含引号内形式——双引号内 `$()` 仍执行）→ 整体回退。审查实测：`cp a '<allowRoot>/$(rm -rf ~/.ssh)'` 在修复前会被提取为目标、前缀命中 allowPath → 零评审提权自动放行且 `$(…)` 内命令先执行（allowPath 信任边界击穿，v0.10.1 因 `$`→复合→回退而不受影响，`$()` 是 v0.11.0 新引入；反引号非复合形态是既有洞一并修掉）。`$VAR`/`${VAR}` 字面展开不受影响（那是 Issue B 的功能）。
  - **trash 搭车说明（审查 MEDIUM 项，维持现状）**：良性工具（`trash`/`mkdir` 等）随白名单快速路径搭车执行，其副作用不再单独过分类器。判断依据：① 删除目标**本身永不进入** allowPathTargets（白名单信任只作用于写目标）；② 单命令 `trash` 本就命中 `DEFAULT_ALLOW` 的 `'trash *'` allow glob 零评审放行（除 deny），复合搭车**不扩大信任面**；③ `rm` 不可恢复、不在良性集、强制回退分类器。移出 `trash` 会破坏导出三步曲（spec 设计场景），故不采纳审查员的移出建议，仅文档化语义（README en/zh 已补）。
  - **效果**：`DIR=...; cp a b_temp && (trash b; true) && mv b_temp "$DIR/b" && ls` → `bashDests=[b_temp, <OneDrive>/b]` → 全部在信任根内 → `curated allowPath` → 桥接 → 提权零确认放行。用户「白名单 OneDrive 可导出」恢复。
- **验证（2026-09-01）**：新增单测（三步复合导出 → 目标提取含 `$VAR` 展开；`&& echo done` 良性尾段不阻塞；pkill/rm/bash/cd/重定向 → `[]` 回退；引号内分隔符不误切；非复合路径回归不变）；`npm run build` + `npm test` 通过。

### Issue C：allowPath 白名单不豁免文件沙箱（workspace-write）对 vault 外写入的拦截（2026-09-01 补记，已处理：文档层 ✅ v0.11.0）

> 本节记录 2026-09-01 JC STEM 会话实测：**即使命令命中 allowPath 白名单，DSH 文件沙箱仍拦截 vault 外（OneDrive）写入**——与 Issue B（复合命令未命中白名单）是**两个独立层**的问题。用户质疑「OneDrive 在白名单里为什么不能导出」。2026-09-01 已处理（文档层，见下）。

- **现象（实测，2026-09-01，auto-mode 会话，session 文件策略 workspace-write）**：
  1. 简单非复合 `cp /tmp/jcstem_export/a_Goals_clean_test.docx "/Users/logan/Library/CloudStorage/OneDrive-个人/Documents/Job/JC STEM 202627/..."` —— 目标在 `config.allowPaths`（个人 OneDrive 根）内，简单 cp 命令 `bashWriteDestinations` 应正确提取目标并命中 `curated allowPath`（2026-08-29 的 E2E 已证简单 cp 落 `pre-execute-allow`）—— 但命令执行仍被拒：`cp: Operation not permitted` + `[sandbox: file access denied under workspace-write mode]` + `[sandbox: escalation available — retry with sandbox_permissions]`；加 `sandbox_permissions=danger-full-access` 重试同一命令才成功复制。
  2. 同类：`export_docx.py`（python 进程内文件写）向同一 OneDrive 目录写 `refs_fixed.json` → `PermissionError: [Errno 1] Operation not permitted`（python 内部 os 写，同被沙箱拦）。
- **根因（对照 DSH 层架构）**：**DSH 文件沙箱（session file policy，workspace-write）与 auto-mode 白名单是两个独立层**。`config.allowPaths` 只作用于 auto-mode 插件的 pre-execute 门——让命中路径跳过插件分类器/approval、并触发 `approval-bridge`（0.10.0 起 `allowed-once`）；但**不改变 DSH 文件沙箱对 vault 外路径的写权限**。workspace-write 沙箱只允许写 workspace（vault 根 / 会话工作区），vault 外（OneDrive、`~/.agents` 等）写入一律被沙箱底层拦截（Operation not permitted / PermissionError EPERM / sandbox marker），与命令是否命中 allowPath、是否复合**无关**。要真正写入 OneDrive 必须把沙箱权限提升到 `danger-full-access`。
- **与既有 issue 的区别（三层各自独立）**：
  - Bug A（2026-09-01，workspace 相对路径误判）：分类器层，cwd/相对路径解析问题——workspace 内文件被误判 out-of-tree 进分类器。
  - Issue B（2026-09-01，复合命令使 allowPath 失效）：`bashWriteDestinations` 不解析复合命令 → `allowPathTargets` 空 → 未命中 allowPath → 落入分类器/approval，且 approval payload 无命令 → 拒。
  - **Issue C（本次）**：allowPath **已命中**（简单 cp / 文件工具），但 **DSH 文件沙箱独立拦截**——白名单永远无法让 vault 外写入通过沙箱，与命令形态无关。
- **影响**：用户「把 OneDrive 加入 allowPaths」的信任声明**不能**让导出自动成功——文件沙箱仍需每次 `danger-full-access`（提权 → 人工/评审），或永久放宽文件策略；与用户预期「白名单 = 免审批写 OneDrive」冲突（用户两次质疑：2026-08-29 复合命令、2026-09-01 简单 cp）。
- **修复方向（已处理，2026-09-01，采用 ④+①：维持现状 + 文档明确边界）**：
  - **决策**：allowPath 只免 auto-mode 评审、不免 DSH 文件沙箱是**层架构事实**（插件改不了沙箱）；「白名单写入免沙箱」需把 `allowPaths` 同步进沙箱 trust roots（harness/补丁层，blast radius 大，属需要用户拍板的安全策略变更，不在本次范围）。插件侧落地：system prompt（`auto-mode:allowlist`）与 README(en/zh) 明确边界——白名单路径写 **workspace 外**仍需 `sandbox_permissions: danger-full-access` 提权，而该提权对白名单路径经 approval 桥接**零评审自动放行**（v0.10.0 语义）——即用户「白名单 = 免审批写 OneDrive」的预期在**带提权**的调用上成立。
  - **实现（已实现）**：`ALLOWLIST_SENTENCE` 补充边界句；README(en/zh)「Trusting extra directories」补充「allowlist ≠ file-sandbox permission」说明。
- **验证（2026-09-01）**：提示词句读核对（无歧义）；README 段落核对。

### Issue D：vault 内「未跟踪测试文件」被 auto-mode 误判为 workspace 外 + 意图不相关而拒绝（2026-09-01 补记，已确认根因 = Bug A 变体 ✅ v0.11.0）

- **现象（实测，2026-09-01，auto-mode 会话）**：DSH `edit` 一个 **vault 内**未跟踪测试文件 `workspace/JC-STEM-2026/plan-draft/_mtime_test.txt`（绝对路径 `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Logans-vault/workspace/...`，明确在 session workspace 内），被分类器拒绝，理由：「The action targets a file outside the trusted working directory and there is no evidence it serves the user's current request; modifying an untracked test file outside the workspace is not clearly aligned and could affect external state.」
- **对照**：同一会话 edit **已 git 跟踪**的 `research-plan-prose-checklist.md`（同在 workspace 内）被正常放行——差异在「是否已跟踪 + 是否与当前请求相关」。
- **根因（已核对，2026-09-01）**：**根因即 Bug A**（原假设 ① 成立）。`edit` 用的是**相对路径** `workspace/JC-STEM-2026/plan-draft/_mtime_test.txt`（现象行本身即相对路径），被 Bug A 的「进程 cwd 解析相对路径」误判 out-of-tree → 分类器被告知「file operation outside trusted workspace: workspace/JC-STEM-2026/plan-draft/_mtime_test.txt」→ 分类器据此（叠加「test file」的意图推断）判 reject，理由里的「untracked / outside the workspace」是其对**错误输入**的合理推演。Bug A 修复后 in-tree 捷径直接放行、分类器不再介入（对照组的已跟踪文件同样受益）。不需要 ②（分类器 prompt 特判 untracked）或 ③——那是在错误前提上打补丁。
- **影响**：auto-mode 会话中编辑测试/临时/未跟踪文件会被误拒（即使明确在 workspace 内），拖慢开发测试节奏。
- **验证（2026-09-01）**：Bug A 单测覆盖相对路径 in-tree（含嵌套子目录路径）；同路径绝对形式本就在-tree（无行为变化）。
- **版本**：0.10.1 → **0.11.0**（行为变更：复合 bash 写命令 allowPath 生效 + workspace 相对路径 in-tree 判定修复 + allowlist 语义边界文档化）。
- **双 agent 审查（2026-09-01，commit 7f409aa 之后）**：安全审查 + 一致性审查并行复核。一致性：可发布、无回归（57 测试全绿、lib 与 src 严格同步、旧断言全部保留）。安全审查：发现 1 高（`$()` 命令替换走私击穿 allowPath 信任边界）1 中（trash 搭车）1 低（管道左侧不独立校验）；另验证 `isInsideTrusted` base 修复、`..` 逃逸、symlink、mv/cp 跨根移动、重定向守卫、子 shell 递归、deny 顺序、parseAssignment、expandShellVars、bridge 关联均正确。处置：HIGH 已修（命令替换守卫，见上）；trash 维持现状 + 文档化（见上）；管道低项为既有语义不改。修复后新增回归测试 6 条（`$(`/反引号/`<(`/引号内 `$()`/`D="$(pwd)"` 回退 + `$VAR` 展开仍工作 + trash/mkdir 搭车语义锁定）。
- **E2E 复测（待重启后）**：运行中的 dsh 进程需重启后加载新 `lib/` 生效；重启后 auto-mode 会话复测——① `edit _internal/log.md`（相对路径）应落 `pre-execute-allow (in-tree / allowPath file op)` 不再进分类器；② 三步复合导出命令应落 `curated allowPath` + `approval-bridge` + `allowed-once` 无 `rejected`；③ `rm`/命令替换复合命令仍回退分类器。




---

## dsh 0.1.5-rc.1 兼容修复（2026-09-10，v0.11.2）

### 现象

- dsh 升级到 **0.1.5-rc.1** 后，auto-mode 会话**每条**消息都失败：UI 显示「本轮运行失败」，会话记录 `turn/start → turn/end {kind:error, message:"Cannot read properties of undefined (reading 'length')"}`。
- 对照：同一内核跑 **headless profile 正常**；关掉 auto-mode 后 web 也正常。

### 根因（实测堆栈定位）

- dsh 0.1.5-rc.1 **移除了 `session.events`** 访问器（读取得到 `undefined`）。auto-mode 有 6 处仍读它：`src/index.ts` 5 处（`isAuto` / `policyOf` / `writeAutoModeKnobs` / `auto-status`）+ `src/pre-execute.ts` 1 处（预设闸门）。
- 因为插件自带 `@deepseek-ai/*` 副本（`dsh-permission-presets@0.1.0-rc.8`），旧 helper `effectivePermissionPreset` 仍能 import → **加载期不报错**，只在运行时炸：`effectivePermissionPreset(session.events)` → `events.length`（events 为 `undefined`）。
- 触发点在**系统提示渲染**：auto-mode 注册 `systemPrompt.context('approval:policy')`，其 `text()` → `policyOf()` → `isAuto()`；该 context 在 `agent/pre-step` 的 `systemPrompt.assemble()` 中被调用 → 整个回合在模型请求前就抛错 → **每条消息必死**。
- 实测堆栈：
  `effectivePermissionPreset (…/dsh-permission-presets/lib/index.js:33)` ← `isAuto` ← `policyOf` ← `Object.text`（auto-mode 的 `approval:policy` context）← `Proxy.assemble`（`dsh-system-prompt`）← `ReactLoopAgent.preStep`（`dsh-agent-loop`）。

### 修复

- 新增 `src/permission-state.ts`：`permissionSnapshot(ctx, session)`
  - 首选 **`ctx.sessionProjections.stateOf(session, 'permissions')`**（0.1.5+ 的持久投影，与内核 `dsh-permission-presets.current()` 同源）→ `preset` / `sandbox` / `approval`。
  - 回退：仍暴露事件日志的旧内核走 `effectivePermissionPreset` / `effectiveSandboxMode` / `effectiveApprovalPolicy(session.events)`。
- `src/index.ts`：`isAuto` / `policyOf` 改为显式接收 `ctx`（全部调用点本就有 ctx）；`writeAutoModeKnobs` / `auto-status` 改用 `permissionSnapshot`；`inject` 增加 `sessionProjections`。
- `src/pre-execute.ts`：预设闸门改用 `permissionSnapshot(ctx, session).preset`。
- 语义保持：`writeAutoModeKnobs` 的 sandbox 比较仍用投影原始值（与旧 `effectiveSandboxMode(events)` 一致，未引入「全局沙箱模式」回退）；approval 仍按 `state.approval ?? ctx.approval.config.policy ?? 'ask'` 回退。

### 验证

- `npm run typecheck` / `npm run build` 通过；`npm test` **62 项全过**（新增 2 条回归：① 「无 `session.events` 的 0.1.5 形态下 `isAuto` 仍正确」——即原 bug 的最小复现用例；② 旧内核走事件日志回退）。
- E2E：auto-mode **保持开启**，对运行中的 dsh web 发消息 → `turn/end → {kind:"completed"}`（修复前必报 `reading 'length'`）。

### 版本

- 0.11.1 → **0.11.2**（bug 修复：dsh 0.1.5-rc.1 移除 `session.events` 导致 auto-mode 每个回合在 pre-step 崩溃）。README(en/zh) 兼容性段落同步。
