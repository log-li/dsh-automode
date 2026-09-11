# 更新日志（Changelog）

**@log.li/dsh-automode** 自上次发布（0.12.0）以来的全部变更。

## [0.14.3] — 未发布（unreleased）

### 变更（Changed）
- **权限 setter 也改为运行时探测**（[issue #1](https://github.com/log-li/dsh-automode/issues/1)，xiaolinziwang）：`setApprovalPolicy` / `setSandboxMode` 改为 namespace import + `typeof` 探测，不再命名导入。新宿主（Desktop 2.0.5 系）整体移除了这些导出——命名导入会在模块实例化期崩溃。setter 缺失时 auto mode **降级**（跳过该 knob + 一次性警告）而非崩溃。
- **兼容层加固**（0.14.2 工作，未单独发布）：`permission-state.ts` 对 legacy `effective*` 导出改用 **namespace import + 运行时 `typeof` 探测**（思路采纳自 [WSL043 的 PR #2](https://github.com/log-li/dsh-automode/pull/2)）。在新版 Harness build / 官方 npm 包**整体移除** `effectivePermissionPreset` 等导出的宿主上，插件加载不再在模块实例化期崩溃；探测不到的 fold 直接跳过事件日志回退（投影路径不变）。保留我们的 fail-soft `{}` 行为（未采纳 PR 的 `throw`）。
- 贡献署名：`package.json` `contributors` 增加 WSL043；实现 commit 带 `Co-authored-by`。

## [0.14.1] — 2026-09-12

### 修复（Fixed）
- **文件工具（write/edit 等，无 `command` 字段）的裁决缓存签名纳入目标目录**。此前签名退化为 `tool | justification | 意图hash`——实测：探针 D 写入 `~/Documents` 被分类器判定后 9 秒，同 justification 的探针 E 写入 `~/Downloads` 直接命中 `verdict cache ALLOW`（跨目录共享裁决，B 文件的内容分类器从未看过）。现在 `dirname(file_path/path/dir/root)`（排序去重）并入 key：**同一目录共享一次裁决**（批量写入同一目录 = 相同安全属性）；**不同目录即使理由逐字相同也不会碰撞**。敏感**文件名**仍由 deny 频带兜底——路径级硬拒（`credentials`、`.ssh/`、dotfile 等）每调用照跑，与缓存粒度无关。bash 的 `command` 签名不受影响。
- 新增 `toolArgsKey()`（`cache.ts`）；pre-execute 门与 approval 路径保持签名一致（共用 v0.13.0 callId 恢复机制拿到的同一份 args）。

### 验证（Verified）
- 运行时 E2E（v0.14.1 重启后）：Documents → 分类器新审；Documents 再写（不同文件名、同理由）→ 缓存命中（同目录共享保留）；Downloads（同理由跨目录）→ **重新分类**（跨目录 bug 消除）。74 项 smoke 全过（新增 4）。探针无残留。

## [0.14.0] — 2026-09-11

### 新增（Added）
- **`scripts/audit.mjs` 判断历史复盘 / 回归哨兵**。扫描 `~/.dsh/auto-mode/decisions.jsonl`：事件分布、审批 outcome 构成、**矛盾对检测**（同 session 同 tool：`pre-execute-allow` 之后 ≤60s 出现 `decision rejected`——即 0.13.0 缓存 bug 的特征签名，真实历史 08-22→09-11 检出 **17 对**，全部是用户明确要求的合法操作被二次分类误否决）。`--fail-on-pairs` 存在矛盾对即 exit 1（CI/cron 告警）。

### 变更（Changed，审计可追溯）
- `pre-execute-deny` 事件补 **命令头部 / 目标路径**（原只记匹配的 pattern——`credentials`×18、`.env`×7 等命中无法事后判断是否误伤）。
- approval 路径 `decision` 事件记录 **`callId`**（可与其 pre-execute 记录精确 join，不再靠时间窗近似）。
- 工作区内提权放行事件改为 **`workspace in-tree escalation`**，不再误标为 `curated allowPath`（行为不变，审计语义修正）。
- **分类器不可用提示区分「配置问题 vs 瞬时问题」**（`classifyFailureCategory`）：未配路由 / `UNSUPPORTED_REASONING_EFFORT`（如 Ollama 模型元数据缺 efforts 列表——不传 effort 也会在 adapter 层失败）→ 指引修复 `classifier.provider/model` 或模型元数据；429/5xx/超时 → 保持「稍后重试」。
- README(en/zh)：日志字段、audit 用法段（替换过期的 `auto-mode-review.mjs` 引用）、allowPath 事件语义。

## [0.13.0] — 2026-09-11

### 修复（Fixed）
- **approval 路径缓存签名与 pre-execute 门一致（消除二次分类）**。复现：同一动作先被门放行（`pre-execute-allow`），约 2 秒后被 approval 路径拒绝（`decision outcome:rejected`）——「先放行、后否决」矛盾对。根因：`VerdictCache.sig` 在门侧用**命令原文**签名、在 approval 侧用**escalation reason 文本**签名（`approval/request` payload 刻意不携带参数）→ key 恒不等 → 缓存 100% miss → 信息更少的第二次分类覆盖信息更全的第一次。修复：`restoreToolCallArgs()` 按 **`callId`** 从会话恢复精确的 tool-call 参数 → 两侧同签名 → 提权调用命中门的裁决；恢复的命令原文同时传入 approval 分类器（`PromptInput.command`）与 deny 频带检查。
- **bash 写命令目标提取支持 `~` 展开与 `trash` 包装脚本**。`bashDests` 对 `~/bin/trash ~/.agents/skills/see-image` 之类恒为 `[]` → `allowPaths`（含 `~/.agents`）与 approval 桥接对这些调用整体失效。修复：全部提取 token 统一 `~`/`$HOME` 展开；`trash`（**可恢复**删除——freedesktop 回收站）从良性工具表移入写命令表，返回其位置参数（须全部落在 `allowPaths` 内，否则整体回退分类器）。不可恢复删除（`rm`/`shred`/`unlink`）仍不在白名单。spec 曾建议的「未识别命令出现绝对路径即提取」通用放宽被**明确否决**（包装脚本内部可 `curl | sh`——allowPath 信任边界击穿）。
- README(en/zh) 安全边界与裁决缓存段同步。

## 上次发布（Previous release）

**0.12.0（2026-09-10）**：显式 dsh peer 范围声明（`>=0.1.0-rc.6 <0.2.0`）、README 兼容性版本矩阵。（0.11.x 及更早见 spec 的 changelog。）
