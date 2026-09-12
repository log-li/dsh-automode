Status: implemented

# dsh-automode：自主审批插件（借鉴 Nuo-cl/dsh-auto-mode 的设计模式，独立实现）

> **本文档为活文档**：创建于 2026-08-22，随版本持续更新（文件名不带日期，日期在内部维护——各版本日期见「变更历史」，最近更新见最新版本条目）。结构：前半为「当前状态」（架构 / 决策链 / 关键行为 / 版本支持 / 已知问题），后半为「变更历史」（changelog，按版本倒序）。历史补记的详细根因分析已压缩进 changelog；**安全边界与关键决策保留**。
>
> 2026-08-25 修订：本文档原题「Fork Nuo-cl/dsh-auto-mode 并重构为 dsh-automode」。本插件**并非 fork**——以自身设计为主，借鉴了 Nuo-cl/dsh-auto-mode 与 pi-automode 的思路与模式独立实现；对二者的贡献见下方「致谢与参考」。

## 核心立场

转 TypeScript（与 DSH 生态一致），以**自身设计**为逻辑基础，**参考** Nuo-cl/dsh-auto-mode 与 pi-automode 的决策链、预执行门、熔断器、两阶段分类器等设计模式（借鉴思路，非代码复用），独立实现、减少重写。

## 致谢与参考

本插件为独立实现，**未 fork 任何上游代码库**。设计上借鉴了以下项目，特此致谢：

- **Nuo-cl/dsh-auto-mode**：auto mode 概念、预执行门（pre-execute gate）、裁决缓存、熔断器、deny/allow 频带、CC 式拒绝引导等设计模式。
- **pi-automode**：两阶段分类器、`allowInsideWorkingDirectory`、`$defaults` 规则机制等设计模式。
- **WSL043**（[PR #2](https://github.com/log-li/dsh-automode/pull/2)，2026-09-10）：权限兼容层的 **namespace-import + 运行时 `typeof` 探测**思路——在新 Harness build 整体移除 legacy `effective*` 导出的宿主上，避免模块加载期崩溃；v0.14.2 采纳该思路加固 `permission-state.ts`。

对外说明建议措辞：`Inspired by Nuo-cl/dsh-auto-mode and pi-automode; compat probing adopted from a contribution by WSL043 (PR #2)`。

## 共识（grill 产出）

| 决策 | 选择 |
|---|---|
| 代码库 | 独立实现 dsh-automode；借鉴 Nuo-cl / pi-automode 的设计模式（见「致谢与参考」） |
| npm 名 | `dsh-automode`（无连字符） |
| peerDeps | 精简到最少必需；`@deepseek-ai/dsh-*` 显式声明 `>=0.1.0-rc.6 <0.2.0`（0.2.0 起未验证，见「版本支持声明」） |
| 语言 | TypeScript |
| 规则体系 | deny（正则硬拒绝）+ allow（前缀 glob 白名单）+ 散文规则给分类器 |
| 读取策略 | 只读工具默认放行，deny 列表里的敏感位置除外 |
| 决策模型 | **二态（allow / reject），无 ask 态**（2026-08-26 定稿：移除三态） |
| 分类器路由 | `classifier.provider` + `classifier.model` 独立配置 |
| pre-execute 门 | 核心差异特性，围栏内外都跑 deny/allow |
| 持久化日志 | JSONL |
| 复盘脚本 | 分析 + 建议 |
| 上游策略 | 先独立维护，后续提 PR |

## 当前架构

### 文件结构

```
src/
  index.ts           主入口：preset 管理、approval answerer（decideAuto）、熔断器复位、/auto + /auto-status、系统提示注入
  config.ts          配置 schema（deny/allow 频带、allowPaths、分类器路由、熔断器阈值、failClosed 等）
  bands.ts           确定性频带引擎（deny 正则 + allow 前缀 glob + 复合 shell 分段解析 + bash 写命令目标提取）
  pre-execute.ts     pre-execute 门（预设闸门、真实路径判定、curated allowPaths、分类器预审、熔断器跳闸注入、approval 桥接记录）
  classifier.ts      分类器（两阶段 + 鲁棒解析 + reasoningEffort + 意图感知缓存签名 + 诊断日志）
  rules.ts           散文规则匹配（$defaults 展开）
  prompt.ts          提示构造（<recent_user_intent> + 意图权重 + 危险优先 + 两态契约）
  cache.ts           裁决缓存（按 tool+command+intent 签名，maxArgsChars）
  breaker.ts         熔断器（3 连续 / 20 总 DENY → 跳闸）
  bridge.ts          AllowPathBridge（approval 桥接：callId → allowed-once，TTL + 容量）
  permission-state.ts 权限事实兼容层（permissionSnapshot：0.1.5+ 投影 / 旧内核事件日志双路径）
  log.ts             持久化 JSONL 日志（appendDecision）
```

### 决策链

```
工具调用到达
  ├─ [pre-execute 门]（所有工具，第一道防线；仅 auto-mode 会话生效）
  │    ① 预设闸门：非 auto-mode → 放行（不干预用户所选沙箱/审批预设）
  │    ② 只读工具 → deny 检查（扫目标路径）→ 无 deny 放行
  │    ③ deny 频带（正则硬拒）→ 拒绝
  │    ④ allow 频带（前缀 glob，非复合）→ 放行
  │    ⑤ 文件工具真实信任检查（in-tree OR allowPath，无提权时）→ 放行
  │    ⑥ 提权意图 OR 越区文件操作 → allowPath 判定（文件工具 targetPaths + bash 写命令 bashTargets）
  │        命中 → 记录 approval 桥接（callId）→ 放行
  │        未命中 → 意图 hash 进缓存签名 → 缓存命中 DENY？→ 拒绝（计入熔断器）
  │        未命中 → 分类器预审（两阶段）→ allow / reject（failClosed 兜底）
  └─ [approval/request 瀑布]（提权/审批触发，第二道防线）
       ① 非 auto-mode → next()
       ② deny 频带（硬 + 软）→ 拒绝
       ③ approval 桥接（callId 命中新鲜记录）→ allowed-once（零评审）
       ④ 裁决缓存命中 → 复用
       ⑤ 分类器（两阶段：one-token 预筛 → 结构化裁决）
       ⑥ 失败 → failClosed
```

### 关键行为

#### 两阶段分类器
- `fastFilter`（one-token 预筛）：512 token 预算 + **独立 0/1 数字解析**，避免 reasoning 模型被 token 预算饿死；传入 `classifier.reasoningLevel` 作为 `reasoningEffort`；若路由不支持 effort（dsh-llm 抛 `UNSUPPORTED_REASONING_EFFORT`，或流以 `finish {kind:'error'}` 终结且 `reason.failure.code === UNSUPPORTED_REASONING_EFFORT`）则**安全回退为不传**（`streamTokens` 统一处理，抛异常与 error-finish 两条路径都重试）。
- `classify`（结构化裁决）：鲁棒解析 JSON verdict（**allow / reject 二态**）；失败返回 null → 调用方按 `failClosed` 处理。
- **两态 prompt 契约**（2026-08-26 定稿）：输出格式仅 `{"decision":"allow"|"reject","reason":"<sentence>"}`；**不确定时 REJECT（fail-closed）**——拒绝可重试或升级到用户，误放不可逆，宁拒勿放。老模型输出 `ask` 时归一为 reject（reason 注明 "uncertain (ask) — treated as reject (fail-closed)"）。
- **反伪装指示**（2026-08-26）：routine 类别（install/build/test/edit/git）**通常**安全/可逆（倾向基准），但必须判断具体命令与参数；显式列出"看似 routine 实则危险"的伪装特征（下载执行远程代码、未知包安装、写 secrets、不可逆删除、推未知 remote、关闭保护、触达共享/生产/外部状态）。
- **风险导向**（2026-08-25）：UNSAFE 清单按动作实际风险（不可逆破坏/泄密/持久化/削弱安全/共享生产外部状态），**不再因「请求提权」机制本身一刀切拒绝**——提权本身不是危险，评估它启用的动作；低风险可逆 + 用户对齐可放行。READ-ONLY and REVERSIBLE operations are ALLOWED。

#### 熔断器
- 3 连续或 20 总 classifier DENY 触发跳闸；跳闸后 auto 暂停，审批转人工。
- **任何一次真实人工决策（allow OR reject）都解除跳闸并清零计数器**（人工参与即打破静默连拒循环）；`cancelled` / `unavailable` 不复位。
- **缓存命中的 DENY 同样计入熔断器**（连续与总计）——否则重复提权场景永远跳不了闸，人工弹窗不来。
- 跳闸瞬间注入 `BREAKER_TRIPPED_HINT`，指示模型**直接在首次尝试就请求 `danger-full-access` 升级**（省去"先试→报错→再升级"往返，立即弹人工窗口）。
- 跳闸/复位分别写 `breaker` / `resume` 事件到 `decisions.jsonl`。

#### 模型引导
- deny 时提示模型「尝试更安全方案」；若**没有更安全方案**，则**停止重试并询问用户明确许可**——只有用户明确批准，后续尝试才可能通过（分类器经 `<recent_user_intent>` 读到用户意图）。
- deny 提示 = 分类器拒绝理由 + **主模型当时的操作解释（justification，如有）** + 安全替代引导。justification 在 escalation 与非 escalation 越区文件操作两条路径都透传。

#### 用户意图
- 分类器经 `<recent_user_intent>`（`renderUserIntent`）读取用户**最近的显式指示**，作为「合法性」强信号；但硬安全边界（泄密/破坏/自身提权沙箱）仍优先。
- **只保留 `source.kind === 'user'` 的人类消息**（排除 tool/plugin/system/model 注入），保证用户授权原话稳定进入意图窗口。
- **工具型授权**（2026-08-31）：`ask_user_question` 的答案（`!isError` 的 tool-result，解析 `answers[].selected/custom`）也渲染为 `user:` 意图行——用户经工具授权后意图 hash 变化 → 缓存签名变化 → 旧 DENY 缓存 miss → 分类器以新授权上下文重跑。错误结果（isError，如用户取消）不算授权。
- **意图进缓存签名**（2026-08-29）：`VerdictCache.sig` 追加 `|intent:<hash>`；`renderUserIntent` 在缓存检查**之前**执行。新用户授权 → hash 变化 → 缓存 miss；同一意图窗口内的重复命令仍命中缓存。

#### 分类器诊断
- `classifier.ts` 把 resolved `provider/model`、底层错误 code/message、以及 `raw` 模型输出写入 **DSH 日志**（不进 decisions.jsonl），用于定位 `classifier returned no verdict` 根因。
- 分类器流失败（error-finish 或抛异常）除 DSH 日志外，**同时写入 `decisions.jsonl` 的 `classifier-fail` 事件**（含 `stage` / `effort` / `route` / 错误 message+code / raw 摘要），使「no verdict」可从审计记录直接复盘。
- pre-execute 门写 `pre-execute-fileop` / `pre-execute-bashop` 诊断事件（`esc/targets/bashDests/inTree/outOfTree/breaker/cwd/argsKeys/cmdHead`），用于定位「为何进/不进分类器」。

#### 预执行门作用域
- 仅在 `auto-mode` 会话生效；非 auto preset（read-only / workspace-write / danger-full-access）一律放行，不与用户所选沙箱/审批预设冲突。

#### 权限预设图标
- `cordis.patch.yml` 的 `presets.auto-mode` 声明 `icon`（内层 SVG path `d`，bolt）；是否渲染取决于 DSH 是否支持消费预设 `icon`（原生 DSH 硬编码 glyph 映射、会静默忽略；本机 DSH 经 `dsh-permission-preset-icon.mjs` 补丁支持）。图标纯外观，不渲染时行为不变。
- **⚠️ schemastery 坑**：`dsh-permission-presets` 的 config schema 用 schemastery（非 zod），其 `Schema` **没有 `.optional()`**（只有 `.required()`/`.default()`），且 `z.object` 字段**默认可选**——补丁必须写 `icon: z.string()`，写 `.optional()` 会让 `static Config = z.object(...)` 在模块加载时抛错，拖垮整个 plugin tree。

#### allowPath 白名单语义
- `config.allowPaths` 即**全信任**：其中文件工具（`targetPaths`）与 bash 写命令（`bashWriteDestinations` 提取的目标）经真实 symlink-resolve 前缀匹配命中 → 跳过分类器（`curated allowPath`）。
- **bash 写命令覆盖**（2026-08-29）：`cp/mv/rsync/ditto/install/tar -x(-C)/unzip(-d)/unar(-d)/curl -o/wget -O/git clone` 等非复合写命令提取目标目录/文件路径。
- **复合命令覆盖**（2026-09-01）：`splitShellSegments`（顶层 `&&`/`||`/`;`/`|`/`&`/换行 分段，引号+括号感知）+ `expandShellVars`（`VAR=...` 赋值跟踪、`$VAR`/`${VAR}` 展开）逐段提取写目标。**守卫**：任一段不是「已识别写命令 / 纯赋值 / 良性工具命令」或含顶层重定向 `>`/`>>` → 整体回退分类器；副作用命令（kill/pkill/rm/sh/bash/网络/守护进程管理…）与**命令/进程替换**（`` `…` ``、`$(…)`、`<(…)`，含引号内形式）出现即回退——防「`curl -o /tmp/e && bash /tmp/e`」类下载执行模式被 allowPath 放行。
- **git 写命令覆盖**（2026-09-04）：`git add/commit/push` 返回其**仓库根**（`-C` 解析、否则取有效 cwd，`cd <dir>` 是受跟踪的良性导航命令）→ 仓库根 in allowPath → 信任。`reset --hard`/`clean`/`rebase`/`merge` 等改写型命令**刻意不含**（留在分类器/硬拒带）；fd-dup 重定向（`2>&1`）不是文件写，不使快速路径失效。
- **安全边界**：deny 频带仍最先执行（`/etc`、`.ssh/`、`.env`、`credentials` 等仍硬拒）；删除类命令（`rm`）不在写命令白名单；allowPath 是用户显式声明的全信任目录，误放风险限于「把文件写进用户自己信任的目录」。
- **allowPath ≠ 文件沙箱权限**（2026-09-01 文档化）：`config.allowPaths` 只免 auto-mode 评审，**不改变 DSH 文件沙箱**对 workspace 外路径的写权限——白名单路径写 workspace 外仍需 `sandbox_permissions: danger-full-access` 提权，而该提权对白名单路径经 approval 桥接**零评审自动放行**。

#### 分类器 prompt 契约（v0.15.0）

判定契约写在 `prompt.ts` 的 `buildSystemPrompt()` 里，是**安全姿态的单一真相**。三条纪律：

- **判据是「效果是否离开本机且无法收回」，不是「external」这个字面。**
  旧版用「changes to shared/production/external state」这个粗词，把两件性质不同的事压成一件：
  「用户已批准、只是内容需要过目」（应交给人过目）与「注入的指令在假冒用户」（应坚决拦住）。
  后果是**一个无害的修复被读成危险动作** —— 移动一个从未产出过任何发布物的 tag 被拒。
  现在点名真正的属性：**其他人或系统受影响，且效果收不回来**（发布产物到 registry、部署、
  推送到用户不拥有的远程、向外交付消息、写生产系统），并要求分类器**判断该属性而非字面措辞**。
- **判定必须针对动作本身，不随叙述漂移。** agent 如何措辞、如何为自己辩解，
  **不得在两个方向上移动判定** —— 自信的、「用户已批准」的、含糊其辞的、自我指涉的都不行。
  依据命令及其参数判定。（实证：同一个 `git tag … && git push`，一次放行、后来拒绝，
  后者差别主要在理由里描述了「如何绕过先前的一次拒绝」。）
- **拒绝理由必须可执行。** 必须写明是什么属性让它不安全（什么到达其他人、什么无法撤销），
  并在用户本人就能执行时说清。裸的 `unsafe` 让 agent 无从下手，只能换形状重试 ——
  **这比一次清晰的拒绝更糟**。

**反注入底线不变**：效果会离开本机的动作，**永远不能仅凭用户请求获得许可**
（`even if the user's words could be read as permission`）。理由：agent 可能被引导着提出它，
也可能把你的请求转述错了，而你看不到即将发布出去的产物。由测试锁定（4 条 prompt 契约测试）。

#### approval 桥接（v0.10.0）
- **问题**：`approval/request` payload 不带 args/路径，approval answerer 无法复用 allowPath 判定 → 白名单提权调用仍被分类器拒。
- **方案**：pre-execute 门对 allowPath 提权放行时，用 **callId**（`tools/pre-execute` 与 `approval/request` 是同一个值）记录桥接；`decideAuto` 在 deny 频带之后、缓存/分类器之前查 `req.callId`：有新鲜桥接记录 → 直接 `allowed-once`（确定性、零 LLM）。
- **安全边界**：deny 频带仍最先执行；桥接只对 pre-execute 已确定性判定「所有目标都在 trust roots 内」的调用生效；熔断器跳闸时不进 allowPath 分支、不记录桥接；桥接记录**消费即删**（take）+ 短 TTL（60s）+ 容量上限（2000）惰性清理。

#### 版本兼容层（permissionSnapshot，v0.11.2）
- dsh 0.1.5-rc.1 **移除了 `session.events`** 访问器（读取得 `undefined`）。插件所有权限事实读取收敛到 `permissionSnapshot(ctx, session)` 一处：
  - 首选 **`ctx.sessionProjections.stateOf(session, 'permissions')`**（0.1.5+ 的持久投影，与内核 `dsh-permission-presets.current()` 同源）→ `preset` / `sandbox` / `approval`。
  - 回退：仍暴露事件日志的旧内核走 `effectivePermissionPreset` / `effectiveSandboxMode` / `effectiveApprovalPolicy(session.events)`。
- 内核再改权限读取方式只需改这一个文件。

## 版本支持声明

**支持的 dsh 版本：`0.1.0-rc.6` – `0.1.x`**（peer 范围 `>=0.1.0-rc.6 <0.2.0`）。权限事实经两条自动探测的读取路径获取：

| dsh 版本 | 权限读取路径 |
|---|---|
| `0.1.0-rc.6` – `0.1.4.x` | `session.events` 事件日志（`effectivePermissionPreset` 等） |
| `≥ 0.1.5-rc.1` | 持久的 `permissions` 会话投影（`ctx.sessionProjections.stateOf`） |

- **`≥ 0.2.0` 未验证**：只有对新内核实测通过后才应上调 peer 范围。
- 不升 major 的理由：单次兼容修复对使用者零行为变化；1.0.0 的时机由 dsh 内核 stable 驱动，不由单次兼容修复驱动。

## 已知问题 / 待办

- **分类器路由解析**：`resolveRoute` 优先级为 `config.classifier → session request header → agent.options`；`classifier.provider/model` 为空时，分类器跟随会话**实际模型**（当前为 DeepSeek），而不是 agent 默认模型。若会话模型本身重/不稳定（reasoning 高开销）导致频繁 `classifier returned no verdict`，建议**固定专用分类器路由**（`classifier.provider/model` 指向支持 `reasoningEffort: off/low` 的轻量非 reasoning 模型）。

- **裁决缓存签名两侧不一致 → 审批路径二次分类，且第二次看不到命令原文**（2026-09-11 实测复现，影响 v0.12.0；**v0.13.0 已修复**，见变更历史）
  - **症状**：同一动作在 pre-execute 门被判 allow（`decisions.jsonl` 写 `pre-execute-allow`），约 2 秒后 approval 路径却写 `decision outcome:rejected`，命令最终未执行。日志呈现「先放行、后否决」的矛盾对。
  - **根因**：`VerdictCache.sig(toolName, reason, args, maxChars, intentHash)`（`cache.ts:36-42`）以 `args.command || reason` 作为签名主体，但两侧传入的 `args` 不同：

    | 调用点 | 传入 args | 签名主体 |
    |---|---|---|
    | `pre-execute.ts:306` | `exec.arguments` | **命令原文** |
    | `index.ts:169` | `undefined`（`index.ts:118`：approval path doesn't carry raw args） | **escalation reason 文本** |

    两个 key 恒不相等 → 缓存 100% miss → approval 路径必然重新调用分类器。
  - **放大器**：approval 路径的分类器输入 `promptInputOf({toolName, reason, userIntent})`（`index.ts:213`）**不含命令原文**；分类器只能凭 justification 散文 + 会话文本判断，于是从旧上下文里挑理由（实测产出「read_image 仍被硬阻断」「用户说过先别动」等已过时论断）并给出 reject。**信息更少的那次裁决反而覆盖信息更全的那次**，与决策链 ④「裁决缓存命中 → 复用」的设计意图相悖。
  - **实测记录**（2026-09-11，session-b90da777，命令为 `~/bin/trash ~/.agents/skills/see-image`）：

    ```
    04:20:04  pre-execute-allow  "Deleting the user-explicitly-named obsolete see-image skill…"
    04:20:06  decision  outcome=rejected
    04:21:43  pre-execute-allow  "User explicitly authorized deleting these two named skill…"
    04:21:45  decision  outcome=rejected
    ```
  - **修复方向**：`decideAuto` 改用 `callId` 作缓存 key（approval 桥接本已按 callId 记录），或在 approval 请求 payload 中透传原始 args；退一步也应让 approval 路径的分类器拿到命令原文。
  - **修复落地（v0.13.0）**：`decideAuto` 按 `req.callId` 从 `deriveMessages()` 恢复精确的 tool-call 块（`restoreToolCallArgs`，`classifier.ts`）取回 `arguments`，作为 `VerdictCache.sig` 的 args → 与 pre-execute 侧同签名、同调用命中 `ALLOW`/`DENY` 缓存；恢复的 command 原文同时传入 `promptInputOf`（`PromptInput.command`）供 approval 分类器判断，deny 频带检查也改用恢复的 args。恢复失败（callId 在窗口外）回退原 reason 签名，不劣于现状。
  - **临时绕法**：白名单内路径优先用 `write`/`edit` 文件工具（走 approval 桥接，零评审零分类器），不要用 bash 写命令。

- **bash 写命令目标提取对「包装脚本 + `~` 路径」返回空 → allowPath 与桥接对 bash 整体失效**（2026-09-11 实测复现；**v0.13.0 已修复**，见变更历史）
  - **症状**：`pre-execute-bashop` 事件恒为 `bashDests=[]`，即使命令明确写了 `~/bin/trash ~/.agents/skills/see-image`。
  - **后果**：allowPath 分支要求 `allowPathTargets.length > 0`（`pre-execute.ts:284`），因此 (a) 已在 `config.allowPaths` 中的 `~/.agents` **完全不参与判定**；(b) `bridge.record(exec.callId, …)`（`pre-execute.ts:295`）不执行 → approval 路径的确定性放行通道（`index.ts:137-149`）永不命中 → 只能落到上一条的二次分类，结果取决于两次分类是否一致。同日另一次会话安装 pptx skill 同为 `bashDests=[]`，但两次分类恰好都 allow → `allowed-once`，即**同类命令的成败取决于分类器抛硬币**。
  - **修复方向**：`bashWriteDestinations` 增加 `~` / `$HOME` 展开，并识别「包装脚本 + 路径参数」形态；至少在命令中出现绝对/home 路径时不应返回空集。
  - **修复落地（v0.13.0）**：`collectSegmentDestinations` 对全部参数 token 统一叠加 `expandHome`（`~` 展开）；`trash` 从良性工具表移入写命令表，`destinationsOf('trash')` 返回全部位置参数（**被删目标**）——trash 是可恢复删除（回收站），目标须全部在 `allowPaths` 内才信任。**否决**「未识别命令 + 出现绝对路径即提取」的通用放宽：脚本内部可 `curl | sh` 下载执行，提取其参数会击穿 allowPath 信任边界；仅识别语义确定的可恢复删除包装脚本。

- **★ 闸门的覆盖面由「是否需要提权」决定，而不是由「动作风险」决定**（2026-09-12 由 `decisions.jsonl` 实证，**未修复，已知取舍**）
  - **事实**：`decisions.jsonl` 里 **228 条 `pre-execute-bashop` 全部 `esc=true`** ——
    **门只在命令申请沙箱提权时才审查**。
  - **因此**：同一个 `npm publish` / `git push --tags`，在**会话工作区内**跑由沙箱直接放行、
    **不产生审批请求 → 门看不见 → 不受审查**；在**工作区外**跑需 `danger-full-access` →
    进闸门 → 按「效果离开本机」判据拒绝。
  - **实证**：2026-09-11 晚两次真实发版（v0.1.0/v0.2.0，工作区内）**完全未被审查**；
    2026-09-12 早从工作区外发布插件则逐一被拦。「auto-mode 变严了」是错觉 ——
    规则未变（该条判据自 v0.8.0 起就在），变的是**工作位置**。
  - **性质**：这是**漏**（比「过严」严重）—— 安全性取决于 `cwd` 而非动作本身的风险。
  - **当前取舍（2026-09-12 决定，保持现状）**：不把发版类动作强制纳入全量审查。
    理由：「工作区内的活 = 用户正在与我一起做的事」是合理且低误报的边界；
    补成全量审查会让**每次发版都必须人工执行**，收益不抵成本。
    **何时应重新考虑**：当「离开本机」的动作开始频繁在工作区内发起时。

## 项目治理规范（对齐行业惯例，2026-09-12）

**Changelog（Keep a Changelog）**
- 顶部常驻 `## [Unreleased]` 段持续跟踪变更；发布时把 Unreleased 内容移入带日期的版本段（`## [x.y.z] - YYYY-MM-DD`，ISO 日期、新版在前）。
- 变更按固定六类分组：`Added / Changed / Deprecated / Removed / Fixed / Security`（安全条目带头 CVE）；不新增第七类。
- 版本标题链接到 compare diff；撤回版本标 `[YANKED]`；changelog 给人类 curated，不是 commit log 转储。

**Commit（Conventional Commits 1.0）**
- `<type>[scope]: desc`（body/footer 可选）；`fix`→PATCH、`feat`→MINOR、`BREAKING CHANGE:`（或 type 后 `!`）→MAJOR。
- 类型：feat/fix/docs/ci/chore/refactor/perf/test 等；footer 用 git trailer（如 `Co-authored-by:`）。

**Release notes（GitHub 惯例）**
- 正文用**裸 `@username`**（不用 markdown 链接）——GitHub 自动渲染 Contributors 头像列表。
- 结构：Highlights（用户可见变化）→ 各变更 `by @user` 归因 → New Contributors（首次贡献者单列）→ Contributors/Community。
- 归因措辞用 `by @user`，不用 "Thanks @user"。

**Contributors 与致谢（All Contributors 精神）**
- `package.json contributors` = 代码/方法实际贡献者（包作者元数据）。
- issue 报告（🐛）、文档（📖）、review（👀）等角色进 README Contributors 表（角色 emoji），与代码作者分开。
- 致谢（Release/CHANGELOG 的 Thanks）可点名 issue 报告者，但不计入 package.json contributor。

## 发布流程（维护者，2026-09-12 起 Actions 自动化）

1. **打 tag 前：CHANGELOG（双语单文件）该版本条目先把 `— unreleased` 改为发布日期**（发布即定稿，避免 tarball/Release notes 残留 unreleased；已发布包的快照不可改）。版本号就绪 + CHANGELOG 更新后：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`（push tag 即触发 `.github/workflows/release.yml`；或 `workflow_dispatch` 手动跑当前 package.json 版本）。
2. Actions 门禁：build + smoke 80 项 + bridge-flow 全过后 → `npm publish`（token = repo secret `NPM_TOKEN`；2027 npm 方向：改 Trusted Publishing/OIDC + `npm publish --provenance`）→ 自动创建 GitHub Release（changelog 从 CHANGELOG.md 抽取）。
3. 前置一次性配置：GitHub repo secret `NPM_TOKEN`（npmjs 生成 Automation token），或在 npmjs Trusted Publishers 配 OIDC。
4. 发布前按全局规则完成 code review 后 push tag（流程见全局规则，措辞不落本公开文档）。

## 变更历史

### v0.15.0（2026-09-12，已完成）

- **预设图标补丁随包发布并泛化**：原生 DSH 把三个内置权限 glyph 写死在客户端、静默忽略预设的
  `icon`，故闪电此前只在一台手工打过 DSH 补丁的机器上可见，而补丁脚本不在任何仓库里、别人无法复现。
  现在 `patches/dsh-permission-preset-icon.mjs` 随包发布（`files` 收录 + `npm run patch:icon`），
  目标发现由写死路径改为**扫描**（`~/.dsh/profiles/*/node_modules` 任意 profile 名 + 全局安装根），
  支持 `--dry-run` / `--profile`；锚点失配**只报告该文件并保持原样**，不再整体中止。
  README（中英）安装节新增「可选 ⚡ 图标」，写明命令、它改什么、以及 DSH 升级/重装插件会冲掉它。
- **发布链路修复**：v0.15.0 首次发布 14 秒失败于 `TS2688`（`npm publish` 触发 `prepublishOnly`
  → `tsc`，而 CI 刻意不装依赖 → 缺 `@types/node`）。改 `npm publish --provenance --ignore-scripts`
  （编译产物 `lib/` 随 git 提交，由 `Verify release artifacts` 断言）。同时清除三个 OIDC 可信发布坑：
  `NODE_AUTH_TOKEN` 空值（会让 npm 改用 token 认证、绕过 OIDC）、`setup-node` 的 `registry-url`
  （写出占位 `_authToken` 的 .npmrc，npm 优先用它 → PUT 报 `E404` 而 provenance 已签署）、
  `node-version: 22`（可信发布要求 npm ≥ 11.5.1）。另使 Release 版本取自 `package.json`，
  让 `workflow_dispatch` 也能正确出 Release。
- **分类器 prompt 契约改进**（见「关键行为 → 分类器 prompt 契约」）：判据由粗词
  「external」改为「效果离开本机且无法收回」；新增「依据命令而非叙述判定」与
  「拒绝理由必须可执行」两条纪律；反注入底线保留。新增 4 条 prompt 契约测试（84 项 smoke 全过）。
- **发现并记录闸门覆盖面漏洞**（见「已知问题」）：门只在申请提权时审查 → 覆盖面取决于 `cwd`。
  当前决定**保持现状**，理由与重新评估条件已写入该条。

### v0.14.4（2026-09-12，已完成）

- **修复两项不对称问题（经独立核验采纳）**（逐条核验采纳，2026-09-12）。
  - **严重1：approval 路径 deny 扫描面 ≠ gate**。v0.13.0 恢复真实 args 后，`classifyBand`（`bands.ts`）以 `JSON.stringify(args)` 全量入 haystack——文件**内容**（content/new_string）进入 deny 扫描；而 gate 自 v0.11.1 起对文件工具**只扫目标路径**（`collectDenyPaths`，避免「文档提到敏感文件名算泄漏」的误伤）。后果：白名单内写入正文含敏感词 → approval 误拒 → allowPath 零评审契约被打破 + 制造「先 allow 后 reject」矛盾对（哨兵误报源）+ 两道防线 deny 语义分叉。
    - **改法**：把「文件工具=扫路径、bash=扫命令文本」的 haystack 构造抽为共享 `denyHaystackFor`（`bands.ts`，`isFileTool`/`collectPaths`/`collectDenyPaths` 从 pre-execute 移入 bands 一起内聚），gate 与 `decideAuto` 的 `classifyBand` 复用同一构造——两线一致、内容不进 deny。属**收紧**（消误拒），路径级硬拒保留。
  - **严重2：文件工具提权时分类器看不到目标路径**。`PromptInput` 无 `paths`；提权分支 `escReason` 仅含 justification；文件工具无 `command` → 分类器只见「提权+理由」，不知写哪个文件 → `write /etc/foo`+提权+无辜理由可盲 allow 并被缓存固化。v0.14.1 修了缓存 key（目录入 key）但没修分类器输入——key 与输入不对称。
    - **改法**：`PromptInput.paths: string[]`；gate 填 `targetPaths`，approval 从 `restoreToolCallArgs` 恢复的 args 提取同一份（`collectPaths`），`buildUserMessage` 渲染。两侧同源 → v0.13.0 签名奇偶性不受影响。属**补全输入**（审更准），不放开边界。
  - **中3**：`toolArgsKey` 逗号拼接可碰撞 → 改 `JSON.stringify([...dirs].sort())`。
  - **中4**：spec v0.14.3 测试声明虚记 → **补正 spec 表述**（探测逻辑由 `probeSetter` 单测覆盖；降级形态为代码审查确认，不做 DI 重构——独立判断：收益低、侵入大，拒绝 review 的 DI 方案）。
  - **中5**：文件工具（write+提权）gate/approval 签名奇偶性无测试 → 新增回归测试钉住。
  - **中6**：`warnSetterMissing` 单布尔 → 改 per-name `Set`。
  - **轻7**：pre-execute 死导入 `classifyBand` → 随本版清理（消除两套 deny 扫描分叉源头）。
  - **轻10**：`classifyFailureCategory` 的 `reasoning effort` 裸子串过宽 → 收紧为完整短语匹配。
  - **轻11**：README audit 段补 `--limit` 用法示例。
  - 落地：80 项 smoke 全过（新增 6：denyHaystackFor 一致性 ×1、paths 渲染 ×1、dirs 碰撞 ×1、file-tool sig 奇偶性 ×1、effort 子串收紧 ×2）；README(en/zh) `--limit` 示例；测试声明补正；版本收敛 0.14.4（0.14.2/0.14.3 未单独发布）。
  - **落地（按核验结论补正）**：① 采纳【严重】遗留——gate 提权分支 `promptInputOf` 补 `command`（v0.13.0 只修了 approval 侧，gate 侧 bash 提权分类器仍只见 justification）；② 采纳【中】——`toolArgsKey` dirs 改 `hashString(JSON…)`（防 `maxArgsChars` 截断把超长 reason 后的 dirs 截出 key、复活跨目录共享）；③ **拒绝【中】**核验无净变化——非文件分支 `commandText||argsText` fallback 与旧版 deny band 行为等价（旧版已扫 args），只读点前移不改最终 deny 结果，不做无依据改动。最终 80 项 smoke 全过，push。
  - **轻8 拒绝**（记录理由）：deny regex 每次 approval 重编译优化收益微乎其微，改预编译需扩 decideAuto 参数——性价比低，不做。
  - **轻12 登记**（范围外，本期不修）：gate 不执行 deletionGuard、bridge 裸 callId 非会话隔离、`ls*` glob 宽匹配、allowPath 内 `git push --force` 跳过分类器——记入已知问题待后续评估。

### v0.14.3（2026-09-12，已完成）

- **修复：权限包写操作 setter 仍直连命名导入 → 新宿主移除导出时加载期崩溃**（[issue #1](https://github.com/log-li/dsh-automode/issues/1)，xiaolinziwang，Desktop 2.0.5）。
  - **背景**：v0.14.2 把 `permission-state.ts` 的 legacy **读**函数（`effective*`）改为 namespace-probe；但 `src/index.ts` 仍**直接命名导入**两个**写操作**：`setApprovalPolicy`（`@deepseek-ai/dsh-user-approval`）与 `setSandboxMode`（`@deepseek-ai/dsh-sandbox-policy`）。新宿主（Desktop 2.0.5 系）移除这些导出时，index.ts 在**模块实例化期** `SyntaxError`——插件整棵加载失败（issue #1 的报错即此形态）。
  - **修复**：两个 setter 改为 **namespace import + 运行时探测**（复用 v0.14.2 的 probe 思路）；缺失时 `writeAutoModeKnobs`/`writeAutoMode` **降级**（跳过对应设置 + `logger.warn` 提示宿主 API 变化），**不崩**（与 fail-soft 一致）。
  - 测试（v0.14.4 补正）：`probeSetter` 单测覆盖探测逻辑；「writeAutoMode 缺 setter 形态」由代码审查确认（setter 为模块级 const、未做 DI，该形态无常驻测试——v0.14.4 已记录此限制）。
  - 落地：`probeSetter` 导出单测（76 项 smoke 全过）；CHANGELOG(en/zh) 合并 0.14.2 未发布条目并补 0.14.3；版本 0.14.1 → 0.14.3（0.14.2 未单独发布）。

### v0.14.2（2026-09-12，已完成）

- **兼容层加固：吸收 PR #2 的 namespace-import + 运行时探测**（外部贡献 WSL043，2026-09-10）。
  - **背景**：PR #2（`fix: support current Harness permission services without breaking legacy hosts`）实测报告：更新的 Harness build / 官方 npm 包**整体删除了 `effectivePermissionPreset` 等 legacy 导出**——而 v0.11.2 的 `permission-state.ts` 仍**直接命名导入**三个 `effective*` 函数。在「导出被移除」的宿主上，我们的模块在**加载/实例化期**即崩（命名导入指向不存在的导出），即使运行时走投影路径根本用不到它们。用户宿主（0.1.5-rc.1）实测导出仍在，故 v0.11.2+ 在用户环境正常——风险只在导出被删的宿主。
  - **采纳**：`permission-state.ts` 改为 **namespace import + `typeof` 运行时探测**（`(mod as unknown as Record<string, unknown>)[name]`，缺失返回 undefined）→ 模块加载期不再依赖 `effective*` 导出存在；回退路径探测不到就跳过（保持我们的 **fail-soft 返回 `{}`**，不学 PR 的 throw）。保留我们的架构优势：`sessionProjections.stateOf` 投影优先 + `session.events` 回退 + 无源返回 `{}`。
  - **测试**：导出 `legacyFold` 供单测（空模块 / 带函数模块 / 非函数值三种形态）；既有 74 项行为不变（投影 / 旧内核回退路径全绿）。
  - 落地：`legacyFold` 导出单测（75 项 smoke 全过）；CHANGELOG(en/zh) 与 `package.json` contributors 署名 WSL043；实现 commit 带 `Co-authored-by: WSL043 <100819018+WSL043@users.noreply.github.com>`（GitHub commit 页已渲染）；spec 文件去日期命名（`dsh-automode-spec.md`，活文档日期在内部维护）。

### v0.14.1（2026-09-12，已完成）

- **修复：文件工具缓存签名不含目标路径 → 同 justification 跨目录共享裁决**（2026-09-12 实测复现，用户指出）。
  - **症状**：write 探针 D 到 `~/Documents`（justification「缓存区分度测试甲」）分类器新审后，9 秒后同 justification 写 E 到 `~/Downloads`（**不同目录**）→ `verdict cache ALLOW` **命中 D 的裁决**。日志：`08:30:23 分类器新审` → `08:30:32 verdict cache ALLOW`。
  - **根因**：`VerdictCache.sig`（`cache.ts:36-51`）的命令主体 = `args.command || reason`；文件工具（write/edit）**没有 `command` 字段** → key 退化为 `toolName | justification文本 | 意图hash`——**路径（目录与文件名）完全不参与**。目录粒度都谈不上：同理由可跨目录任意共享（除 deny 频带先拦的部分）。
  - **决策（用户拍板，2026-09-12）**：**按目标目录粒度入 key**（不是完整路径，也不是文件名）——同一目录下写多个文件（批量导出等）安全属性相同，共享一次裁决合理；**文件名敏感由 deny 频带兜底**（`collectDenyPaths` 对每个 `file_path` 每调用照跑，与缓存无关：`.env`、`.ssh/`、`credentials` 等仍硬拒）。
  - **实现**：新增 `toolArgsKey`（`cache.ts`）供 `VerdictCache.sig` 使用：有 `command`（bash）→ 命令原文（行为不变）；无 `command` 的对象 args → 提取 `file_path/path/dir/root`（含数组）各自 `dirname`，**排序去重**后拼入 key（`reason |dirs:…`）；无路径字段 → 回退 reason（兼容）。两侧一致：pre-execute 与 approval 共用同一份 `args`（v0.13.0 恢复机制），sig 内统一提取。
  - **边界**：目录用 `dirname` 字符串（不做 realpath——symlink/`..` 变体会多审一次，属安全侧）；deny 盲区内的敏感文件名由用户规则负责（职责划拨：LLM 不按文件名枚举安全规则）。
  - 测试：74 项 smoke 全过（新增 4：同目录共享 / 跨目录 D→E 回归（含存储层断言）/ 多目标排序去重 / bash 命令优先+路径字段忽略+无路径回退）；README(en/zh) verdict cache 段同步；版本 0.14.0 → 0.14.1。

### v0.14.0（2026-09-11，已完成）

- **审计复盘：矛盾对哨兵 + 决策统计（A）**。基于 2026-09-11 对 `decisions.jsonl`（4700 条，08-22→09-11）的复盘：17 条 `decision rejected` **全部**呈现「同 session 同 tool 的 `pre-execute-allow` 在 ≤60s 前出现」的矛盾对形态——即 v0.13.0 修复的 Bug 1/2 症状在 08-25 起系统性存在（17 对全部是用户明确要求的合法操作被二次分类否决）。新增 `scripts/audit.mjs` 复盘脚本：扫描 decisions.jsonl，输出事件分布 / 工具构成 / **矛盾对检测（>0 即告警，防回归）** / failClosed 拒因归类；独立工具，不改变运行时。
  - 落地：`detectContradictionPairs` / `loadDecisions` / `summarize` 导出可测；CLI 支持 `--fail-on-pairs`（存在矛盾对 exit 1，CI/cron 哨兵）与 `--limit N`；对真实历史数据验证输出 17 对（gap 2–4s，全部为 v0.13.0 前记录）。
- **审计可追溯增强（E）**：
  - `pre-execute-deny` 事件补命令上下文：bash 带 `cmdHead`、文件工具带 `targets`（原只有匹配的 deny pattern，无法事后判断 `credentials`×18、`.env`×7 等命中是否为误伤）。
  - `decision` 事件带 `callId`（原无，矛盾的两次裁决只能靠时间窗近似 join）。
  - **in-tree 提权事件语义修正**：pre-execute 的 `trustRoots` 把 session cwd 并入 roots（`pre-execute.ts:70`），导致「工作区内 + 带 `sandbox_permissions`」的文件操作也命中 allowPath 分支，事件却记为 `curated allowPath`——审计会误读为「config.allowPaths 命中」。改为区分 `curated allowPath`（命中 `config.allowPaths`）与 `workspace in-tree escalation (session cwd in trust roots)`；行为不变（均确定性放行 + 桥接）。
- **分类器不可用提示分类（C）**：复盘发现 10 次 `classifier-fail` 全为外部/配置问题——429 配额（ocg 路由）与 `UNSUPPORTED_REASONING_EFFORT`（ollama 路由 4 次）。后者根因在 dsh-llm adapter：不传 effort 时仍校验模型元数据默认值（`dsh-session-persistence-jsonl/worker.cjs:4849-4853`），ollama 模型元数据缺失 → 回退重试也失败——**非插件回退逻辑 bug**，属部署配置。实现：`classifier.ts` 导出 `classifyFailureCategory`（`config:no-route` / `config:unsupported-effort` / `transient:{timeout,rate-limit,overload,server,connection}` / `unknown`），index.ts 与 pre-execute.ts 的 `classifierUnavailableText` 共用：配置性问题给出「修复 provider/model 或换路由，重试无用」指引，取代误导性的「temporarily unavailable」；`no classifier route` 也从通用文案细化为配置指引。
- **复现记录：B 候选否决（性能优化不成立）**。复盘初判「edit 承担 86% 分类器调用（2746/3224）」经复现修正：`pre-execute-allow` 细分实为 in-tree 快捷 2328 / 缓存 ALLOW 415 / **真分类器 350** / allow 频带 70 / allowPath 66。in-tree 提权调用实际已被「roots 含 cwd」的 allowPath 分支**确定性放行**（复现：同目标 edit 带/不带 `sandbox_permissions` 均零 LLM 放行），并非进了分类器；真分类器 350 次/20 天的 edit（217 条）全是 `~/.agents` 等 out-of-tree 正常审核（allowPaths 配置 08-31 后才覆盖）。→ **无性能优化空间，不做决策链变更**；本版改进收敛到审计（A/E）与提示（C）。
- 测试：70 项 smoke 全过（新增 3：矛盾对检测 ×2、classifyFailureCategory 分类 ×1）+ bridge flow 4 断言；README(en/zh) 日志段（callId / deny 上下文 / audit 脚本）与 allowPaths 语义段同步；`auto-mode-review.mjs` 死引用（README 遗留，脚本早已不存在）替换为 `scripts/audit.mjs`。

### v0.13.0（2026-09-11，已完成）

- **修复：approval 路径裁决缓存签名与 pre-execute 不一致**（「已知问题」首条，2026-09-11 实测）。
  - 方案：`decideAuto` 按 `req.callId` 从 `deriveMessages()` 恢复**精确的 tool-call 块**（`b.type === 'tool-call' && b.id === callId`），取其 `arguments` 作为 `VerdictCache.sig` 的 args → 与 pre-execute 侧（`exec.arguments`）**同签名** → 同一次调用的 approval 路径命中 pre-execute 已写缓存，不再二次分类；恢复失败（callId 不在会话窗口 / 块缺失）回退 reason 签名（不劣于现状）。
  - 放大器同步修复：恢复的 command 原文传入 `promptInputOf`（`PromptInput.command`）→ approval 路径分类器能看到命令原文；`classifyBand` 的 deny 频带检查也改用恢复的 args（命令原文进 deny 频带，审查更严）。
  - 零内核改动：approval payload 仍不带 args（`dsh-user-approval` 的 `ApprovalRequest` 注释明示 arguments 不重复携带），从会话按 callId 恢复是纯插件侧等价方案。
  - 实现：`restoreToolCallArgs` 导出自 `classifier.ts`（对象与 JSON 字符串两种 `arguments` 形态都解析）；`decideAuto` 顶部一次性 `deriveMessages()`，deny band / 缓存签名 / 分类器输入三处共用（intentHash 与 pre-execute 侧一致——意图窗口只含 user 消息，门与审批之间不会插入 user 消息）。

- **修复：bash 写命令目标提取对 `~` 与包装脚本返回空**（「已知问题」次条，2026-09-11 实测）。
  - 方案 A：`collectSegmentDestinations` 的 expanded token 映射统一叠加 `expandHome`（`~`/`$HOME` 展开；`$HOME` 原已由 `expandShellVars` 处理，`~` 为新增）——覆盖 `~/bin/trash …`、`git clone <url> ~/dir`（原 git 分支只对 `-C`/repo 展开，clone 目标未展开）。
  - 方案 B：`trash` 从良性工具表（原被当无目标良性命令跳过，是 `bashDests=[]` 的直接原因）移入写命令表，`destinationsOf('trash', argv)` 返回**全部位置参数（被删目标）**。语义依据：`trash` 为可恢复删除（freedesktop 回收站），deny 频带仍最先硬拒 system 路径（`trash|mv /etc|/usr|…`），rm/shred 等不可恢复删除仍不在白名单；目标须**全部**在 `allowPaths` 内才信任（`every` 检查），否则整体回退分类器。
  - **边界**：不做「未识别命令 + 出现绝对路径即提取」的通用放宽——`python3 install.py /trusted` 之类脚本内部可 `curl | sh` 下载执行，提取其参数即击穿 allowPath 信任边界；spec 2026-09-11 补记中的该建议方向**明确否决**，仅识别语义确定的可恢复删除包装脚本。
  - 行为影响：复合命令（temp→swap 三步曲）中出现的 `(trash b; true)` 现在把 `b` 也计入目标集，allowPath 判定要求其同样在信任根内，否则整体回退分类器——比 v0.11.0 的「trash 搭车不复查」更严格且更安全；README(en/zh) 的安全边界段已同步。
  - 测试：67 项 smoke 全过（新增 5 项：trash 目标提取 ×2、`~` 展开 ×1、`restoreToolCallArgs` ×2 + 签名一致性回归 ×1 并入 cache 段）。

### v0.12.0（2026-09-10）
- **版本支持声明**：peerDeps 显式化（`>=0.1.0-rc.6 <0.2.0`，语义同 `^0.1.0-rc.6` 但显式声明 0.2.0 未验证）；README(en/zh) 兼容性段落升级为版本矩阵；README 开头 dsh 加超链接指向 deepseek-harness repo。

### v0.11.2（2026-09-10）
- **dsh 0.1.5-rc.1 兼容修复**：0.1.5-rc.1 移除 `session.events`，插件 6 处读取点（`isAuto`/`policyOf`/`writeAutoModeKnobs`/`auto-status`/pre-execute 闸门）在系统提示渲染（`approval:policy` context → `agent/pre-step` assemble）时抛 `Cannot read properties of undefined (reading 'length')`，每条消息必死。修复：新增 `permission-state.ts`（`permissionSnapshot` 双路径：0.1.5+ 投影优先 + 旧内核事件日志回退），`isAuto`/`policyOf` 显式接收 ctx，`inject` 增加 `sessionProjections`。62 项 smoke 测试全过（新增 2 条回归：无 `session.events` 形态 / 旧内核回退）。

### v0.11.1（2026-09-04）
- **git 写命令 allowPath**：`bashWriteDestinations` 对 `git add/commit/push` 返回仓库根（`-C` 解析、否则取有效 cwd）；`cd <dir>` 成为受跟踪的良性导航命令；fd-dup 重定向（`2>&1`）不属文件写。改写型 git 命令（`reset --hard`/`clean`/`rebase`/`merge`）刻意不信任。60 项 smoke 测试全过。

### v0.11.0（2026-09-01）
- **复合 bash 写命令 allowPath 生效**：`splitShellSegments` + `expandShellVars` 逐段解析复合命令（temp→trash→mv 导出三步曲），提取写目标并集；**副作用命令守卫** + **命令替换守卫**（`` `…` ``/`$(…)`/`<(…)` 含引号内形式 → 整体回退，防 allowPath 信任边界击穿）。
- **workspace 相对路径 in-tree 修复**：`isInsideTrusted` 增加 `base` 参数（会话工作区根），相对路径（`_internal/log.md` 等）正确解析到 workspace 内 → 命中 in-tree 捷径不过分类器。
- **allowlist 语义边界文档化**：allowPath ≠ 文件沙箱权限（白名单路径写 workspace 外仍需提权，提权经桥接零评审放行）。
- 双 agent 审查：1 高（命令替换走私）已修、1 中（trash 搭车）维持现状 + 文档化、1 低（管道左侧）为既有语义不改。57 项测试全绿。

### v0.10.1（2026-08-31）
- **工具型授权不再被旧 DENY 缓存吞掉**：`ask_user_question` 的答案（`!isError` tool-result）纳入 `renderUserIntent` 作为 `user:` 意图行 → 意图 hash 变化 → 缓存签名变化 → 分类器以新授权上下文重跑。48 项测试全过（新增 4 条）。

### v0.10.0（2026-08-31）
- **approval 桥接**：allowPath 提权调用零评审零确认自动放行。新增 `src/bridge.ts`（`AllowPathBridge`：callId → allowed-once，TTL 60s + 容量 2000 + 消费即删）；pre-execute 门 allowPath 分支记录桥接，`decideAuto` 在 deny 之后、缓存/分类器之前查桥接。安全边界：deny 频带仍最先执行、熔断器跳闸不记录桥接、非白名单路径不进桥接。

### v0.9.2（2026-08-30）
- **deny 理由去重**：分类器 deny 分支把完整理由同时塞进 category 槽与 reason 槽导致重复，category 改为短标签 `classifier:unsafe`。
- **macOS 软链 allowPath 新建文件失效**：`realpathSafe` 对不存在路径改为「找最近存在的祖先 realpath + 拼接尾部」，`/tmp` 新文件命中 `/private/tmp` 根。
- README 新增「Compatibility & contributions」段（仅 macOS 验证声明）。

### v0.9.1（2026-08-30）
- **deny 理由 200 字符截断修复**：`parseVerdict` 的 `reason.slice(0, 200)` 移除，完整理由透传（受分类器 maxTokens 2048 约束，不会无限长）。
- **allowlist 配置位置注入系统提示**：`auto-mode:allowlist` context（order 116）告诉模型 allowPaths 配置位置/改法/安全边界；AUTO_SENTENCE 两态化纠错（原句仍写三态）；提示合计 1099 → ~810 字符。

### v0.9.0（2026-08-29）
- **裁决缓存意图感知**：`VerdictCache.sig` 追加 `|intent:<hash>`（djb2 → base36），`renderUserIntent` 提前到缓存检查之前——用户授权后缓存 miss、分类器以新意图重跑。
- **allowPaths 覆盖 bash 写命令**：`tokenizeShell` + `bashWriteDestinations` 对非复合写命令（cp/mv/rsync/tar -C/curl -o/git clone 等）提取目标；allowPath 判定改为「文件工具 targetPaths + bash 写命令 bashTargets」任一命中即信任。
- **配置归属**：个人 OneDrive 路径不进默认配置（9bb483c 已移除），由用户 profile 覆写 `config.allowPaths`（两个 OneDrive 根目录）。

### v0.8.0（2026-08-26）
- **两态化**：分类器只输出 `allow`/`reject`，删除 `ask` 态与 `classifier.askFallback` 配置；老模型输出 ask 归一为 reject（fail-closed）。理由：ask 无触发契约、askFallback=false 下 ≡ reject、人工通道已由熔断器提供、ask 会削弱熔断保护。
- **deny 提示增强**：回显分类器理由 + 主模型 justification + 安全替代引导；非 escalation 越区文件操作补 justification 透传。
- **反伪装指示**：routine 类别从绝对化断言改为「通常安全 + 必须判断具体命令与参数 + 显式伪装特征清单」。

### v0.7.0（2026-08-25）
- **风险导向分类**：UNSAFE 清单去掉「自我扩权」一刀切，按动作实际风险裁决（可逆性 + blast radius + 用户对齐）；READ-ONLY and REVERSIBLE operations are ALLOWED。
- **人类消息意图窗口**：`renderUserIntent` 只保留 `source.kind === 'user'` 的人类消息（排除 tool/plugin/system/model 注入）。
- **熔断器缓存计数**：缓存命中的 DENY 同样计入熔断器（否则重复提权永远跳不了闸）。
- **effort 回退 + off 默认**：`streamTokens` 对 error-finish 与抛异常两条路径都重试（不传 effort）；默认 `classifier.reasoningLevel` 改为 `off`（实测 off 与不传均 ~1–1.7s 返回、无 reasoning 块、不超时）。

### v0.6.x（2026-08-25 及之前）
- **v0.6.1**：移除默认配置中的个人 allowPaths（9bb483c）。
- **v0.6.0**：pre-execute 诊断事件（`pre-execute-fileop`/`pre-execute-fail-open`）+ `resolveRoute` 防御性修复（`agent.options` 缺失时避免 fail-open）。
- **v0.5.0**：熔断器任何人工决定即复位、分类器稳定性 + `resolveRoute` 会话跟随、deny 引导、预设图标、in-tree 路径修复（`session.cwd` 恒 undefined → 改用 `session.header?.cwd`）。

### v0.4.1（2026-08-22）
- 初始版本：CC 式自动审批（deterministic deny/allow + pre-execute gate + 两阶段分类器 + 熔断器 + JSONL 审计）。
