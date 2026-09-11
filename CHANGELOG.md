# Changelog

All notable changes to **@log.li/dsh-automode** since the previous release (0.12.0).

## [0.14.4] — 2026-09-12

### Fixed (independent glm-5.3-flash review, decisions recorded in spec)
- **Deny-scan parity between enforcement points**: the approval path scanned FULL args (document content) while the gate scanned only target paths — a whitelisted write whose body mentioned a sensitive word was wrongly denied, breaking the zero-review allowPath contract and mis-firing the contradiction-pair sentinel. Shared `denyHaystackFor()` (file tools → paths only; bash → command text) now backs both gate and approval.
- **Escalated file-tool calls now show the classifier its target paths** (`PromptInput.paths`): previously an escalated `write` was judged from justification prose alone (file tools carry no command).
- `toolArgsKey` dirs are JSON-serialized (comma join could collide `{/a,b}` with a single `/a,b` dir); `warnSetterMissing` tracks per-setter (both may be reported); `reasoning effort` substring match tightened; dead `classifyBand` import removed; spec's stale test claim corrected. A file-tool sig-parity regression test now documents the gate↔approval reason-template coupling.

### Changed (0.14.3 work, not published separately)
- **Permission setters are now runtime-probed too** (issue #1 by xiaolinziwang): `setApprovalPolicy` / `setSandboxMode` are loaded via namespace import + `typeof` probe instead of named imports. Newer hosts (Desktop 2.0.5 series) removed these exports — a named import crashed plugin load at module-instantiation. Missing setter → auto mode degrades (skip knob + one-time warning) instead of crashing.
- **Compatibility layer hardened against hosts that removed the legacy `effective*` exports** (0.14.2 work, not published separately):
- **Permission setters are now runtime-probed too** (issue #1 by xiaolinziwang): `setApprovalPolicy` / `setSandboxMode` are loaded via namespace import + `typeof` probe instead of named imports. Newer hosts (Desktop 2.0.5 series) removed these exports — a named import crashed plugin load at module-instantiation. When a setter is missing, auto mode **degrades** (skips that knob + one-time warning) instead of crashing; the fail-soft path is kept.
- **Compatibility layer hardened against hosts that removed the legacy `effective*` exports** (0.14.2 work, not published separately): (adopted from [PR #2 by WSL043](https://github.com/log-li/dsh-automode/pull/2)): `permission-state.ts` now loads those helpers via **namespace import + runtime `typeof` probing** instead of named imports. On newer Harness builds / official npm packages where `effectivePermissionPreset` & co are removed entirely, plugin loading no longer fails at module-instantiation; a missing fold simply skips the event-log fallback (projection path unchanged). Our fail-soft `{}` behavior is kept (the PR's `throw` was not adopted).

## [0.14.1] — 2026-09-12

### Fixed
- **Verdict cache for file tools now folds the TARGET DIRECTORY into the cache key.** Writes/edits carry no `command`, so the signature used to collapse to `tool | justification | intent` — a write probe to `~/Documents` (classified) was cached and a probe to `~/Downloads` **with the identical justification text, 9 seconds later**, hit `verdict cache ALLOW` (cross-directory sharing). The key now includes `dirname(file_path/path/dir/root)` (sorted, deduped); **same directory shares one verdict** (batch writes = the same safety profile), **different directories never collide** even with byte-identical justification. Sensitive *filenames* remain the deny band's job — path-level hard denies (`credentials`, `.ssh/`, dotfiles…, re-checked on every call) are unaffected by cache granularity. Bash `command`-based signatures are unchanged.
- New `toolArgsKey()` in `cache.ts`; pre-execute gate and approval path stay signature-consistent (same args source from the v0.13.0 callId restore).

### Verified
- E2E on the running harness (v0.14.1): Documents → classified; Documents again (different filename, same justification) → cache hit (same-dir share kept); Downloads (same justification) → **re-classified** (cross-dir bug gone). 74 smoke tests pass (4 new). Probe files cleaned up.

## [0.14.0] — 2026-09-11

### Added
- **`scripts/audit.mjs` — decision-history audit / regression sentinel.** Scans `~/.dsh/auto-mode/decisions.jsonl`: event distribution, approval-outcome mix, and the **contradiction-pair check** (same session+tool: `pre-execute-allow` followed ≤60s by `decision rejected` — the exact signature of the 0.13.0 cache bug, which produced **17 pairs in the real 08-22→09-11 history**, all legitimate user-requested actions wrongly re-rejected). `--fail-on-pairs` exits 1 when pairs exist (CI/cron alert).

### Changed (audit traceability)
- `pre-execute-deny` events now carry the **command head / target paths** (previously only the matched pattern — `credentials`×18, `.env`×7 etc. were not auditable for false positives).
- Approval-path `decision` events now record the **`callId`** (precise join to the pre-execute record instead of a time-window approximation).
- In-workspace escalations are logged as **`workspace in-tree escalation`** instead of being mislabeled `curated allowPath` (same behavior, correct audit semantics).
- **Classifier-unavailable hints distinguish configuration from transient problems** (`classifyFailureCategory`): no route / `UNSUPPORTED_REASONING_EFFORT` (e.g. an Ollama model whose metadata lacks the effort list — retrying without effort still fails at the adapter layer) now tell the model to fix `classifier.provider/model` or the model metadata; 429/5xx/timeout keep the "retry later" guidance.
- README(en/zh): logging fields, audit-usage section (replaces a stale `auto-mode-review.mjs` reference), allowPath event semantics.

## [0.13.0] — 2026-09-11

### Fixed
- **Approval-path verdict-cache signature now matches the pre-execute gate (no more double classification).** Repro: the same action was allowed by the gate (`pre-execute-allow`) and then **rejected ~2s later** by the approval path (`decision outcome:rejected`) — the "allow-then-deny contradiction pair". Root cause: `VerdictCache.sig` signed with the *command text* on the gate side but with the *escalation-reason text* on the approval side (the `approval/request` payload deliberately omits args) → keys never matched → 100% cache miss → a second, worse-informed classifier run that overrode the gate's verdict. Fix: `restoreToolCallArgs()` recovers the exact tool-call arguments **by callId** from the session, so both sides sign the same text and an escalated call hits the gate's cached verdict. The recovered command also feeds the approval-path classifier prompt (`PromptInput.command`) and the deny-band check.
- **Bash write-command target extraction now handles `~` and the `trash` wrapper.** `bashDests` was always `[]` for e.g. `~/bin/trash ~/.agents/skills/see-image` → `allowPaths` (incl. `~/.agents`) and the approval bridge never engaged for those calls. Fix: every extracted token gets `~`/`$HOME` expansion, and `trash` (a **recoverable** delete — freedesktop recycle bin) moved from the benign-utility table into the write-command table, returning its positional targets (all must resolve inside `allowPaths`, else the whole call falls back to the classifier). Irrecoverable deletes (`rm`, `shred`, `unlink`) remain unallowlisted. The spec's proposed "extract any absolute path from unknown commands" relaxation was explicitly **rejected** (a wrapper script could `curl | sh` inside — trust-boundary bypass).
- README(en/zh) safety-boundary and verdict-cache sections synced.

## Previous release

**0.12.0 (2026-09-10):** explicit dsh peer-range declaration (`>=0.1.0-rc.6 <0.2.0`), compatibility version matrix in README. (See the spec's changelog for 0.11.x and earlier.)

---

# 更新日志（Changelog）

**@log.li/dsh-automode** 自上次发布（0.12.0）以来的全部变更。

## [0.14.4] — 2026-09-12

### 修复（独立 glm-5.3-flash review 检出，决策见 spec）
- **两道防线 deny 扫描一致**：approval 路径曾扫全量 args（含文件内容），gate 只扫目标路径——白名单写入正文含敏感词会被误拒，破坏零评审契约并让矛盾对哨兵误报。共享 `denyHaystackFor()`（文件工具→仅路径、bash→命令文本）现同时支撑 gate 与 approval。
- **提权文件工具调用把目标路径传给分类器**（`PromptInput.paths`）：此前提权 `write` 仅凭理由文本被评判（文件工具无 command）。
- `toolArgsKey` 目录改 JSON 序列化（逗号拼接可碰撞）；`warnSetterMissing` 按 setter 名跟踪；`reasoning effort` 子串匹配收紧；清理死导入 `classifyBand`；补正 spec 虚记的测试声明；新增文件工具签名奇偶性回归测试（记录 gate↔approval reason 模板耦合）。

### 变更（0.14.3 工作，未单独发布）
- **权限 setter 改为运行时探测**（[issue #1](https://github.com/log-li/dsh-automode/issues/1)，xiaolinziwang）：`setApprovalPolicy` / `setSandboxMode` 改 namespace import + `typeof` 探测。缺失时 auto mode **降级**（跳过 + 一次性警告）而非崩溃。
- **兼容层加固**（0.14.2 工作，未单独发布）：
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
