<div align="center">

# dsh-automode ⚡

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Code 风格自动模式：让 agent 放手自主执行，同时由确定性护栏 + 低成本复审模型把危险操作挡在执行之前。**

> 🌐 **简体中文**: [README.zh.md](./README.zh.md) · **English**: [README.md](./README.md)

[![npm](https://img.shields.io/npm/v/@log.li/dsh-automode)](https://www.npmjs.com/package/@log.li/dsh-automode)
[![npm downloads](https://img.shields.io/npm/dm/@log.li/dsh-automode)](https://www.npmjs.com/package/@log.li/dsh-automode)
[![license](https://img.shields.io/npm/l/@log.li/dsh-automode)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/log-li/dsh-automode)](https://github.com/log-li/dsh-automode)
[![GitHub last commit](https://img.shields.io/github/last-commit/log-li/dsh-automode)](https://github.com/log-li/dsh-automode)
[![TypeScript](https://img.shields.io/github/languages/top/log-li/dsh-automode)](https://github.com/log-li/dsh-automode)
[![DSH plugin](https://img.shields.io/badge/DSH%20plugin-ecosystem-2ea043)](https://github.com/topics/dsh-plugin)

<img src="docs/auto-mode-icon.png" width="400" alt="dsh-automode" />

</div>

---

dsh-automode 是护栏插件，介于 agent 与 harness 之间，在**每次工具调用执行前**拦截——硬 `deny` 规则与 curated `allowPaths` 确定性裁决（零 LLM 开销），其余交给两阶段分类器。安全操作全自动放行；危险操作被拦截、改写或转交给你。

## ✨ 核心特性

- 🛡️ **确定性第一道防线** —— 正则 `deny` 频带在任何 LLM 调用之前硬拒外泄、密钥与系统路径；前缀 glob `allow` 规则零成本放行常规命令。
- ⚡ **零确认白名单** —— `config.allowPaths` 即全信任：其中文件操作与 bash 写命令完全跳过分类器，提权调用经 approval 桥接自动放行（v0.10.0）——不弹窗、不来回。
- 🧠 **省成本的两阶段分类器** —— 约 1 token 的粗筛预判，仅命中项进入结构化复审；相同动作 5 分钟内复用判决缓存。
- 🔁 **熔断器 + 人工兜底** —— 连续 3 次（或累计 20 次）DENY 暂停自动模式并转人工；一次人工决定即恢复并清零。
- 📜 **完整审计轨迹** —— 每次 allow / deny / bridge 决定都追加到 `~/.dsh/auto-mode/decisions.jsonl`。
- 🔌 **原生预设** —— 权限选择器一键开启或 `/auto`；与只读 / workspace-write / danger-full-access 并存。

> ⚠️ **它不是沙箱**。插件运行在 [DSH](https://github.com/deepseek-ai/deepseek-harness) 进程内，蓄意恶意的插件可以做你用户账户能做的任何事。它用于降低不安全的自主工具使用，而不是 OS 安全边界。

## 📚 目录

- [安装](#安装)
- [命令](#命令)
- [工作原理](#工作原理)
- [规则](#规则)
- [配置](#配置)
- [日志](#日志)
- [架构](#架构)
- [兼容性与贡献](#兼容性与贡献)
- [许可证](#许可证)

## 安装

```bash
dsh plugin add @log.li/dsh-automode
```

从本地 checkout：

```bash
dsh plugin add ./path/to/dsh-automode
```

安装后重启 `dsh web`。权限选择器（聊天框左下角）会显示 **Auto mode**，与只读 / workspace-write / danger-full-access 并列。

## 命令

```text
/auto           # 把本会话切换到 auto 模式
/auto-status    # 显示诊断：preset、审批策略、熔断器状态
```

## 工作原理

```text
工具调用到达
  │
  ├─ [pre-execute 门]（所有工具，第一道防线）
  │    ① 只读工具 → 放行（除非命中 deny）
  │    ② deny 规则（正则）→ 硬拒绝
  │    ③ allow 规则（前缀 glob）→ 放行
  │    ④ 工作区内文件操作 → 放行（allowInsideWorkingDirectory）
  │    ⑤ 升级意图 → 分类器预审
  │    ⑥ 其余 → 放行
  │
  └─ [approval 瀑布]
       ① 散文 deny 规则 → 拒绝
       ② 散文 allow 规则 → 放行
       ③ 只读 allowlist → 放行
       ④ 裁决缓存命中 → 复用（不二次调用 LLM）
       ⑤ 分类器（两阶段：one-token 预筛 → 结构化裁决）
       ⑥ 失败 → fail-closed
```

![Auto mode 工具调用拦截管线](docs/auto-mode-flow.zh.png)

> 🖱️ **可交互版本**：[docs/auto-mode-flow.zh.html](docs/auto-mode-flow.zh.html) —— 平移缩放、关系追踪、暗色模式。图表源数据：[`docs/auto-mode-flow.zh.workflow.json`](docs/auto-mode-flow.zh.workflow.json)。

pre-execute 门拦截**所有**工具调用（包括工作区沙箱内、本来不会触发 approval 瀑布的那些）。approval 瀑布只对真正需要沙箱升级的调用运行。pre-execute 门**仅对 auto-mode 会话生效**；在其他 preset（read-only / workspace-write / danger-full-access）下它是 no-op，不会与你所选沙箱冲突。

## 规则

规则体系分两层：

### 硬边界（确定性，永不进分类器）

- **`deny`** — 正则模式，硬拒绝。首个匹配生效。在所有检查之前求值。用于加密外泄、密钥、敏感目标、危险命令。
- **`allow`** — 前缀 glob 模式，不调用任何 LLM 直接放行。在 deny 之后求值。用于你完全信任的常规命令。

### 分类器引导（散文，喂给 LLM）

- **`rules.deny`** — 软拒绝描述。分类器把它们视为常驻拒绝。可被用户直接意图或匹配到的 allow 规则覆盖。
- **`rules.allow`** — 软放行例外。分类器把它们视为常驻放行，会覆盖匹配的软拒绝规则。
- **`rules.environment`** — 上下文事实（受信仓库、基础设施、云存储桶）。分类器据此判断某动作是否在用户环境内。

所有 `rules.*` 数组都支持 **`$defaults`**：用 `["$defaults", "my custom rule"]` 保留内置规则并添加你自己的；省略 `$defaults` 则整个用你的替换内置列表。

## 配置

配置写在 profile 的 `cordis.patch.yml`。一切都有默认值，裸 `{}` 配置也合法。下表是完整参考；最小示例（`allowPaths` 覆写）见 [信任额外目录](#信任额外目录allowpaths)。

### 关键选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `deny` | 内置列表 | 正则模式，硬拒绝。首个匹配生效。 |
| `allow` | 内置列表 | 前缀 glob，不调用 LLM 放行。 |
| `readOnlyTools` | read, glob, grep, list, search | 默认放行的工具（除非命中 deny）。 |
| `allowPaths` | `[]` | 全信任的外部目录：目标落在其中的文件操作与 bash 写命令跳过分类器；v0.10.0 起提权调用也自动放行（`approval-bridge`）。见 [信任额外目录](#信任额外目录allowpaths)。 |
| `allowInsideWorkingDirectory` | `true` | 工作区内文件操作不经分类器。 |
| `classifier.provider` / `classifier.model` | `''`（跟随会话） | 覆盖分类器 LLM 路由。解析顺序：`classifier.{provider,model}` → 会话当前模型 → agent 配置模型。 |
| `classifier.reasoningLevel` | `off` | 分类器推理强度（`off` 关闭推理）。若路由拒绝该 effort，调用会重试不传 effort。 |
| `rules.deny` | `['$defaults']` | 分类器软拒绝散文。 |
| `rules.allow` | `['$defaults']` | 分类器软放行散文。 |
| `rules.environment` | `['$defaults']` | 分类器环境事实。 |
| `failClosed` | `true` | 分类器失败时拒绝，vs. 回退到审批链。 |
| `preExecuteGate` | `true` | 启用 pre-execute 门（仅 auto-mode 会话生效）。 |
| `timeoutMs` | `45000` | 分类器 LLM 调用的单次硬超时。 |
| `classifyContextChars` | `6000` | 给分类器的任务对齐上下文字符预算。 |
| `maxArgsChars` | `4000` | 裁决缓存 key 用的命令签名字符预算。 |
| `breakerConsecutive` | `3` | 连续分类器 DENY 触发熔断。 |
| `breakerTotal` | `20` | 总分类器 DENY 触发熔断。 |

### 信任额外目录（`allowPaths`）

`allowPaths` 是用户 curated 的**全信任**列表：目标解析后落在其中任一目录内的文件操作与 bash 写命令，完全跳过安全分类器（日志记为 `pre-execute-allow` / `curated allowPath`）。随插件发布的默认只保留通用 `/tmp/`——**个人目录改在 profile 的 `cordis.patch.yml` 配置**。loader patch 会整体替换目标行的 `config`，所以下面的最小覆写只设 `allowPaths`（其余字段回退到插件代码默认值）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: auto-mode
  config:
    allowPaths:
      - /tmp/
      - /Users/<you>/Library/CloudStorage/OneDrive-<tenant>/Projects/<proj>/Proposal/
```

只有被识别的写命令才会被信任（删除类命令 `rm`/`trash` 绝不会被白名单放行）；路径在 symlink 解析后匹配，`/Users/<you>/OneDrive - …` 软链与真实 `Library/CloudStorage/…` 路径都可用。白名单目录内的 `git add`/`commit`/`push` 会把**仓库根**解析为写目标，因此对位于 allowPath 下的仓库做提交/推送也会跳过分类器（v0.11.1）。下面的裁决缓存修复仍然重要：即便没有 allowPath，你一旦显式授权某个动作，分类器也会带着你的意图重跑，而不是回放旧的缓存拒绝。

**复合写命令（v0.11.0）**。临时文件→替换的导出三步曲（如 `DIR=…; cp a b_tmp && (trash b; true) && mv b_tmp "$DIR/b"`）现在会按段解析（含 `VAR=…` 赋值跟踪与 `$VAR` 展开），其目标仍能命中 `allowPaths`。`cd <dir>` 是受跟踪的良性导航命令——它更新有效工作目录（使后面的 `git add/commit/push` 据此解析仓库根），且不使快速路径失效（`cd -` 仍不可预测，回退分类器）。快速路径仍有守卫：复合命令若含副作用命令（`kill`、`pkill`、`rm`、`sh`、`bash`、网络/守护进程管理等）、命令替换（`` `…` ``、`$(…)`、`<(…)`）、文件重定向（`>file`、`>>file`、`2>file`）或写/良性集之外的任何命令，一律回退分类器，与之前行为一致。**fd-dup 重定向**（`2>&1`、`>&2`、`>&-`）不是文件写入，不使快速路径失效——所以 `git push … 2>&1 | tail` 仍可被白名单判定。复合内的良性工具（`trash`、`mkdir`、`echo` 等）随白名单快速路径搭车执行——一旦所有写目标都在白名单内，其副作用不再单独过分类器（删除目标本身永不进入白名单信任判定，`rm` 仍强制回退分类器）。改写历史的 git 命令（`reset --hard`、`clean`、`rebase`、`merge`）**刻意不**进入白名单信任。

**零确认提权（v0.10.0）**。allowlist 路径意味着**全信任**：请求放宽沙箱（`sandbox_permissions: danger-full-access`）进入 allowlist 路径的调用现在**无需任何确认、不经分类器直接放行**——pre-execute 门已确定性证明所有目标都在 `allowPath` 内，该结论通过调用的 `callId` 传给 approval answerer（审计日志呈现 `curated allowPath` → `approval-bridge` → `decision allowed-once`）。deny 频带仍最先执行（`~/.ssh/` 等 deny 路径即便在 allowPath 内也硬拒），熔断器也不会被绕过——跳闸期间 allowlist 调用仍走人工。

**不是文件沙箱豁免**。`allowPaths` 只跳过**本插件**的评审——DSH 文件沙箱（会话文件策略）是独立一层，仍然生效。写 **workspace 外**的 allowlist 目录会被沙箱拦截，除非调用带 `sandbox_permissions: danger-full-access`；而该提权对 allowlist 路径经 approval 桥接**零评审自动放行**——所以第一次尝试就直接带上提权即可。

每个 **auto-mode** 会话也会通过系统提示段（`auto-mode:allowlist`）获得这份知识：模型知道 per-profile 的 `allowPaths` 配置在哪、怎么改——动作被拦截时可以给出精确的配置修改建议，且**只有在你明确确认后**才会实际改动。

### 权限预设图标

`auto-mode` 预设默认在权限选择器里显示 ⚡ 图标。想换 logo，就覆盖**预设**上的 `icon`（`cordis.patch.yml` 的 `permission` 行，不是 `auto-mode` 自身配置）——一个画在盾牌轮廓内的 SVG 路径：

```yaml
- id: permission
  config:
    presets:
      auto-mode:
        sandbox: workspace-write
        approval: ask
        name: Auto mode
        description: ...
        icon: '<你的-svg-path-d>'   # 默认 bolt：'M9.15 3.4L5.85 8.55H7.95L7.05 12.6L10.45 7.25H8.25L9.15 3.4Z'
```

图标只是**外观**——无论是否渲染，行为完全一致。它只在支持读取预设 `icon` 的 DSH 上显示（原生 DSH 会忽略；本机 `dsh-permission-preset-icon.mjs` 补丁开启）。不设 `icon` 即用默认 bolt。

### 两阶段分类器

分类器用两阶段把 LLM 成本降到最低：

1. **One-token 预筛**（~1 token）：让 LLM 只回一个数字（0 = 安全，1 = 需审查）。使用宽松的 token 预算和鲁棒的数字解析，避免 reasoning 模型被饿死，并把 `classifier.reasoningLevel` 作为推理强度传入（`off` = 不推理）。大多数常规动作返回 0 直接跳过阶段 2。
2. **结构化裁决**：仅当阶段 1 标记时才运行。返回完整 verdict 及理由。

这意味着大多数工具调用只产生 ~1 token 的分类器开销，只有边界情况才 incur 完整分类器成本。

分类器是**风险导向**的——它判断动作的**真实影响**，而不是表面形式：

- **只读与可恢复操作一律 ALLOW**：GET/HEAD 请求、检视/列举/搜索/状态查询，以及可以安全撤销的本地改动（编辑、临时文件、构建、测试、git 跟踪文件）。
- **沙箱提权请求本身不是危险**——分类器判断它启用的动作。可逆、低影响面、与用户意图对齐的动作，即使需要提权也可放行（例如编辑工作区外的 git 仓库 skill/配置文件）；为真危险动作（泄密、持久化、削弱安全、共享/生产/外部状态）提权仍被禁止。
- **`<recent_user_intent>` 只计入直接的人类消息**——但有一个刻意例外：用户经 `ask_user_question` 工具给出的答案也是**经由工具的直接人工授权**，会被并入意图窗口（并进入裁决缓存签名，使「工具型授权」与「打字授权」一样能让旧的 `DENY` 缓存失效）。普通工具结果、插件/系统注入、模型消息仍被排除——你的真实指令不会被挤掉，也只有人类才能授予权限。

### 熔断器

当分类器在会话内连续拒绝 3 个动作、或累计 20 个时，熔断器跳闸，auto 模式暂停。approval 瀑布转交人工 answerer。**任何一次真实人工决策（允许或拒绝该动作）都会恢复 auto 模式并清零所有计数器**——人工参与即打破熔断器要抓的静默连拒循环。若用户取消请求、或没有可用 answerer，熔断器保持跳闸。

在熔断器跳闸的瞬间，插件会注入一段提示，告诉模型在**下一次尝试就直接请求 `danger-full-access` 沙箱升级**（立即弹出人工批准窗口），而不是"先以当前权限试一次 → 命中 denied → 再升级"的多余往返。

分类器失败（超时、解析错误、空响应）**不计入**熔断器。**但缓存命中的拒绝会计入**——完全相同的已拒动作重试（verdict cache 命中）同样增加连续与总计计数，因此重复提权尝试能真正触发熔断器并到达人工审批，而不是永远空转。

### 拒绝引导与诊断

分类器为**两态（allow / reject），无 ask 层**——不确定的动作直接拒绝（fail-closed）：拒绝可重试或升级到用户，误放不可逆，宁拒勿放。

routine 类别（install/build/test/文件编辑/git add/commit/status）只是**倾向基准，不是免检通行证**——分类器必须判断**具体命令与参数**，不能只看类别标签（例如管道下载执行远程代码、未知包安装带任意 postinstall 脚本、写入 secrets、不可逆删除、推送未知 remote）。

拒绝时，提示会回显**审查者的拒绝理由 + 模型自身在工具调用里写的操作解释（justification）**，让模型看清被拒的是什么、如何改造成更安全的形式。随后指示模型尝试更安全方案；若**没有更安全方案存在**，则**停止重试并询问用户明确许可**——被拒绝的动作会一直失败，只有用户明确批准，后续尝试才可能通过（分类器经 `<recent_user_intent>` 权衡用户的最近显式意图）。

每次分类器流失败（抛异常**或** `error` finish chunk）都会写入 DSH 日志（带解析后的路由、effort、底层错误 code/message、模型原始输出），并作为 `classifier-fail` 事件写入 `decisions.jsonl`——反复出现的 `classifier returned no verdict` 直接从审计记录即可诊断。若路由拒绝配置的 `reasoningEffort`（例如只支持 `off` 的路由收到 `low`），调用会先重试不传 effort 再判定失败。

### 裁决缓存

分类器 verdict 按会话的 **tool + 命令 + 用户意图** 签名缓存。用户最近直接指示——**打字消息与 `ask_user_question` 答案**——会被 hash 进签名，因此一次新的显式授权（新的人类消息或工具型授权）会使旧的缓存 verdict 失效、分类器带着新意图重跑——**用户的授权绝不会被缓存的 `DENY` 吞掉**。在同一意图窗口内，重复动作仍会复用缓存 verdict，不再二次 LLM 调用。缓存条目 5 分钟后过期。

## 日志

所有决策写入 `~/.dsh/auto-mode/decisions.jsonl`（JSONL 格式，append-only，跨重启保留）。每条记录包含：

- `at` — ISO 时间戳
- `event` — decision / pre-execute-deny / pre-execute-allow / pre-execute-fileop / pre-execute-bashop / pre-execute-fail-open / classifier-fail / breaker / resume / boot
- `outcome` — allowed-once / rejected / cancelled
- `tool` — 工具名
- `tier` — deny / allow / classify:monitor / classify:cache / classify:fail / ...
- `detail` — 人类可读理由
- `sessionId` — 会话标识

用复盘脚本分析日志、识别规则优化机会：

```bash
node scripts/auto-mode-review.mjs
```

## 系统提示影子化

当 auto 模式激活时，插件会"影子化"审批策略的系统提示，让模型看到 "auto" 而不是 "ask"。这告诉模型：工具拒绝来自自动化审查者，而非人类。模型会相应调整重试策略（尝试更小/更安全动作，而不是问用户）。

## 架构

```text
src/
  index.ts         主入口：preset 管理、审批 answerer、熔断器复位、命令、系统提示影子化
  config.ts        配置 schema + $defaults 机制 + 内置规则列表
  bands.ts         确定性频带引擎（deny 正则 + allow glob）
  pre-execute.ts   pre-execute 门（第一道防线；真实路径信任、分类器预审、熔断跳闸提示）
  classifier.ts    两阶段分类器（+ 鲁棒解析、推理强度、诊断）
  rules.ts         分类器散文规则匹配
  prompt.ts        分类器提示构造（<recent_user_intent> + 意图加权）
  cache.ts         裁决缓存（跨强制点共享）
  breaker.ts       熔断器（3 连续 / 20 总）
  log.ts           共享 appendDecision JSONL 日志器
```

## 兼容性与贡献

**支持的 dsh 版本：`0.1.0-rc.6` – `0.1.x`**（peer 范围 `>=0.1.0-rc.6 <0.2.0`）。权限事实（预设 / 沙箱 / 审批策略）经两条自动探测的读取路径获取：

| dsh 版本 | 权限读取路径 |
|---|---|
| `0.1.0-rc.6` – `0.1.4.x` | `session.events` 事件日志（`effectivePermissionPreset` 等） |
| `≥ 0.1.5-rc.1` | 持久的 `permissions` 会话投影（`ctx.sessionProjections.stateOf`） |

dsh `0.1.5-rc.1` 移除了 `session.events` 访问器——没有投影路径时，每个 auto-mode 回合都会在组装系统提示时报 `Cannot read properties of undefined (reading 'length')`（v0.11.2 修复）。**dsh `≥ 0.2.0` 尚未验证**——只有对新内核实测通过后才应上调 peer 范围。
- **仅在 macOS 上验证**。已针对 macOS 文件系统、[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 运行时与开发时使用的 DSH 版本做过测试。路径语义——包括 macOS 的 `/tmp` → `/private/tmp` 软链（由 realpath 最近祖先解析处理）与工作区路径信任——**尚未在 Linux / Windows 上验证**，deny 模式与路径匹配在这些平台上可能有差异。
- **发现 bug，或其它平台上有问题？** 欢迎提交 issue 或 PR：[github.com/log-li/dsh-automode](https://github.com/log-li/dsh-automode)。

## 许可证

[MIT](./LICENSE)
