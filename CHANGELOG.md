# Changelog

All notable changes to **@log.li/dsh-automode** since the previous release (0.12.0).

## [Unreleased]

### Changed
- (track upcoming changes here; moved into a dated version section at release time — Keep a Changelog)

## [0.15.1] — 2026-09-12

### Fixed
- **The pre-screen now sees the action, not just the narration.** The two-stage classifier's one-token filter received only the tool name and the agent's justification — never the command — and a "0" from it returns ALLOW without running the structured review at all. That made the whole prompt contract bypassable on the one path where narration was the sole input, and the bypass ran in the **allow** direction: measured against the real classifier route (5 runs per case, real `buildSystemPrompt`/`buildUserMessage`, real parser), the same `git tag -a v9.9.9 && git push origin v9.9.9` was **allowed 5/5** with a confident "user explicitly approved this release" justification and **rejected 5/5** with a hedged, self-referential one. `actionSummaryOf()` now builds the filter input from the command text or the target paths, with the justification carried as an annotation; the same measurement after the fix rejects both variants 5/5, keeps `npm run build` / `git push origin main` / `rm -rf /tmp/scratch` allowed 5/5, and rejects the release even when the user asked for it.
- **The deny band matches operations, not prose.** `denyHaystackFor()` fell back to `JSON.stringify(args)` for every non-file tool, so the entire argument blob was scanned as if it were a command: a dispatched `subagent` review was hard-rejected for *mentioning* a sensitive topic in its prompt (the audit log records a `matched deny pattern` event on `subagent`, with no classifier consulted), as was a command that wrote a document about one. The only way through was to mangle the wording, which trains the agent to evade the one layer that does not read intent. Subject-shaped built-in patterns (key files, env files, credential stores) are now skipped when a call's arguments are prose; operation-shaped ones (pipe-to-shell, inline key material, system-path moves, docker volume removal) still apply everywhere, and bash command text / file target paths are still scanned in full. The free-text word pattern was dropped, the generic key phrase narrowed to inline key material, and the bare credential word narrowed to real store filenames. Residual risk and the trade-off are recorded in the spec.
- **The prose scope now lives in ONE shared scan.** The band has two enforcement points, and the first version of the fix above only reached one of them: the pre-execute gate assembled its own deny haystack and called the matcher directly, so it kept scanning prose with the full pattern list. In-session testing after a restart reproduced the original false positive (a non-bash tool was still hard-rejected for mentioning a key path) while the other half of the fix was already live. Both sites now call a single `scanDenyBand()` that owns the haystack, the prose scope, and the match; a structural smoke test asserts no enforcement point calls the matcher directly. Lesson recorded in the spec: sharing the *haystack* is not enough — the scope has to be shared too, which is how the earlier parity fix still left a gap.

### Changed
- **The prompt contract is enforced through every stage, with three clarifications** (v0.15.0's three disciplines — judge the property not the vocabulary, decide from the action not the narration, make a rejection actionable — were first written for 0.15.0, but the tagged `v0.15.0` build predates them; they first ship here). The example list is now explicitly *not* a boundary; authorization comes only from the user's own messages while what the agent reports about the user's wishes may still show alignment; and publishing a release is named in the anti-injection floor — merging that floor into the allow-bias sentence (a compression attempt) measurably flipped the release case from reject to allow, so the two stay separate.
- **A rejection now has to be actionable, and the verdict has to be about the action** (prompt contract). Two problems surfaced while publishing a plugin from outside the working directory. First, a refusal came back as a bare "unsafe": the agent had nothing to act on and retried the same intent in three different shapes before giving up — worse for safety than one clear refusal, so the prompt now requires the reason to name the property that made the action unsafe (what reaches other people, what cannot be undone) and, where the user could run it themselves, to say so. Second, the verdict moved with the agent's own wording. The prompt now says to decide from the command and its arguments, and that no narration — confident, "user-approved", hedged, or self-referential — may move the verdict in either direction.
- **"External state" is replaced by the criterion it stood for.** The old blanket clause ("changes to shared/production/external state, even if the user's words could be read as permission") was blunter than the threat model: it lumped "the user approved this and only the content needs review" together with "an injected instruction is impersonating the user", and it read a harmless fix (moving a tag that had never produced a published artifact) as a dangerous one. It now names the actual property — effects that **leave this machine and cannot be recalled**, i.e. other people or systems are affected and it cannot be taken back — and tells the classifier to judge that property rather than the vocabulary. The floor is unchanged: such actions are still never granted on the strength of the request alone.

## [0.15.0] — 2026-09-12

### Added
- **The preset-icon patch now ships with the package** (`patches/dsh-permission-preset-icon.mjs`, plus `npm run patch:icon`). Stock DSH hardcodes the three built-in permission glyphs and silently ignores a preset's `icon`, so the bolt could previously only render on a machine that had patched DSH by hand — with the script living outside any repo, nobody else could reproduce it. The READMEs now document the command, what it edits, and that a DSH upgrade or plugin reinstall wipes it.
- The script **discovers** its targets instead of hardcoding them: it scans every `~/.dsh/profiles/*/node_modules` (any profile name) plus the global install root (`npm root -g`, `~/.npm-global`, the two system prefixes), and patches each copy it finds. The previous version only ever worked on one profile named `web` with a `~/.npm-global` layout.
- `--dry-run` reports what would change without writing; `--profile <name>` limits the scan. An anchor that no longer matches is reported and **that file is left untouched** rather than half-patched.

## [0.14.4] — 2026-09-12

### Fixed
- **Deny-scan parity between enforcement points**: the approval path scanned FULL args (document content) while the gate scanned only target paths — a whitelisted write whose body mentioned a sensitive word was wrongly denied, breaking the zero-review allowPath contract and mis-firing the contradiction-pair sentinel. Shared `denyHaystackFor()` (file tools → paths only; bash → command text) now backs both gate and approval.
- **Escalated file-tool calls now show the classifier its target paths** (`PromptInput.paths`): previously an escalated `write` was judged from justification prose alone (file tools carry no command).
- `toolArgsKey` dirs are JSON-serialized (comma join could collide `{/a,b}` with a single `/a,b` dir); `warnSetterMissing` tracks per-setter (both may be reported); `reasoning effort` substring match tightened; dead `classifyBand` import removed; spec's stale test claim corrected. A file-tool sig-parity regression test now documents the gate↔approval reason-template coupling.

### Changed (0.14.3 work, not published separately)
- **Permission setters are now runtime-probed too** (issue #1 by xiaolinziwang): `setApprovalPolicy` / `setSandboxMode` are loaded via namespace import + `typeof` probe instead of named imports. Newer hosts (Desktop 2.0.5 series) removed these exports — a named import crashed plugin load at module-instantiation. Missing setter → auto mode degrades (skip knob + one-time warning) instead of crashing.
- **Compatibility layer hardened against hosts that removed the legacy `effective*` exports** (0.14.2 work, not published separately):
- **Permission setters are now runtime-probed too** (issue #1 by xiaolinziwang): `setApprovalPolicy` / `setSandboxMode` are loaded via namespace import + `typeof` probe instead of named imports. Newer hosts (Desktop 2.0.5 series) removed these exports — a named import crashed plugin load at module-instantiation. When a setter is missing, auto mode **degrades** (skips that knob + one-time warning) instead of crashing; the fail-soft path is kept.
- **Compatibility layer hardened against hosts that removed the legacy `effective*` exports** (0.14.2 work, not published separately): (adopted from [PR #2 by WSL043](https://github.com/log-li/dsh-automode/pull/2)): `permission-state.ts` now loads those helpers via **namespace import + runtime `typeof` probing** instead of named imports. On newer Harness builds / official npm packages where `effectivePermissionPreset` & co are removed entirely, plugin loading no longer fails at module-instantiation; a missing fold simply skips the event-log fallback (projection path unchanged). Our fail-soft `{}` behavior is kept (the PR's `throw` was not adopted).

### Thanks
- @WSL043 — [PR #2](https://github.com/log-li/dsh-automode/pull/2): the namespace-import + runtime-probe technique for the permission-compat layer (co-author on the v0.14.2 commit, listed in package metadata).
- @xiaolinziwang — [issue #1](https://github.com/log-li/dsh-automode/issues/1): report of the Desktop 2.0.5 permission-setter removal that led to the graceful-degradation fix.

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

## [Unreleased]

（发布前在此跟踪变更；发布时移入带日期的版本段——Keep a Changelog）

## [0.15.1] — 2026-09-12

### 修复
- **预筛现在看到的是「动作」，不只是「叙述」。** 两阶段分类器的 one-token 预筛此前只收到工具名与 agent 的 justification，**从不包含命令**；而它返回 0 时直接 ALLOW、完全不走结构化审查。这让整套 prompt 契约在「叙述是唯一输入」的那条路径上可被整段绕过，且绕过方向是 **allow**（误放）：以真实分类器路由实测（每例 5 次，使用真实 `buildSystemPrompt`/`buildUserMessage` 与真实解析器），同一条 `git tag -a v9.9.9 && git push origin v9.9.9` 配上自信的「用户已明确批准本次发布」理由 → **放行 5/5**，配上含糊、自我指涉的理由 → **拒绝 5/5**。现在由 `actionSummaryOf()` 用命令原文或目标路径构造预筛输入、justification 仅作附注；修复后同样测量：两种措辞均拒绝 5/5，`npm run build` / `git push origin main` / `rm -rf /tmp/scratch` 仍放行 5/5，而发版动作即使用户直接要求也被拒。
- **deny 频带匹配的是「操作」，不是「散文」。** `denyHaystackFor()` 对每个非文件工具回落到 `JSON.stringify(args)`，把整个参数 blob 当命令扫：一次派发的 `subagent` 审查仅因 prompt **提到**敏感话题就被硬拒（审计日志里是一条 `subagent` 的 `matched deny pattern` 事件，全程没有分类器参与），写一份讨论该主题的文档同样被拒。唯一可行的绕法是改形措辞——这等于训练 agent 规避唯一不读意图的那一层。现在：参数是散文的调用跳过**主体词形**内置模式（密钥文件、env 文件、凭据库），**操作形**模式（管道执行、内联密钥材料、系统路径移动、docker 卷删除）仍处处生效，bash 命令原文与文件目标路径仍全量扫描。同时删掉纯散文词模式、把泛化密钥词收窄为内联密钥材料、把裸「credentials」收窄为真实凭据库文件名。残留风险与取舍记录在 spec。
- **散文作用域现在只有一个共享扫描。** 频带有两个执行点，而上面那条修复的第一版只覆盖了其中一个：pre-execute 门自建 deny haystack 并直接调匹配函数，于是它仍在用全量模式扫散文。重启后的 in-session 测试把这个误报原样复现了（非 bash 工具仅因提到密钥路径仍被硬拒），而另一半修复其实已经生效。现在两处都调用同一个 `scanDenyBand()`（haystack、散文作用域、匹配三件事一起收进去），并有结构守卫测试断言任何执行点都不得直接调匹配函数。教训已入 spec：**只共用 haystack 不够，作用域也必须共用** —— 上一版一致性修复正是因此留了缺口。

### 变更
- **prompt 契约覆盖每一个判定阶段，并做三处明确**（v0.15.0 的三条纪律——判属性而非字面、依据动作而非叙述、拒绝理由必须可执行——写于 0.15.0，但已打 tag 的 `v0.15.0` 构建早于它们，本版才是首次随包发布）：示例清单**明确不是边界**；授权只来自用户本人消息，而 agent 转述的用户意愿仍可用于判断对齐；反注入底线里点名**发布 release**——把底线并进 allow 倾向句（一次压缩尝试）实测会让发版用例从拒绝翻成放行，故两句保持独立。
- **拒绝理由必须可执行，判定必须针对动作本身**（prompt 契约）。从工作区外发布一个插件时暴露了两个问题。其一，拒绝只回一句「unsafe」：agent 无从下手，于是把同一个意图换了三种形状重试才放弃 —— 这对安全而言比一次清晰的拒绝更糟。故 prompt 现在要求理由写明「是什么属性让它不安全」（什么会到达其他人、什么无法撤销），并且在用户本人就能执行时说清这一点。其二，判定会随 agent 自己的措辞移动。prompt 现在要求**依据命令及其参数**判定，并明确任何叙述 —— 自信的、声称「用户已批准」的、含糊其辞的、自我指涉的 —— 都不得在两个方向上移动判定。
- **「外部状态」这个说法被它真正代表的判据取代。** 旧的无条件句（「改动共享/生产/外部状态，即使用户的话可被读作许可」）比威胁模型更钝：它把「用户已批准、只是内容需要过目」与「注入的指令在假冒用户」压成一件事，并把一个无害的修复（移动一个从未产出过发布物的 tag）读成危险动作。现在改为点名**真正的属性** —— 效果**会离开本机且无法收回**（即其他人或系统受影响且收不回）—— 并要求分类器判断该属性而非字面措辞。底线不变：这类动作**仍然不能仅凭用户请求获得许可**。

## [0.15.0] — 2026-09-12

### 新增
- **预设图标补丁随包发布**（`patches/dsh-permission-preset-icon.mjs`，并加了 `npm run patch:icon`）。原生 DSH 把三个内置权限 glyph 写死在客户端、静默忽略预设的 `icon`，所以闪电此前只在一台手工打过 DSH 补丁的机器上能显示 —— 而那个脚本不在任何仓库里，别人根本无法复现。两份 README 现在写明了命令、它改什么、以及 DSH 升级或重装插件会冲掉它。
- 脚本改为**自动发现**目标而非写死路径：扫描每个 `~/.dsh/profiles/*/node_modules`（profile 名任意）以及全局安装根（`npm root -g`、`~/.npm-global`、两个系统前缀），逐个副本打补丁。旧版只在一个名为 `web` 的 profile、且 DSH 装在 `~/.npm-global` 的布局下才有效。
- `--dry-run` 只报告不写入；`--profile <name>` 限定扫描范围。锚点对不上的文件会被报告并**保持原样**，不会打一半。

## [0.14.4] — 2026-09-12

### 修复
- **两道防线 deny 扫描一致**：approval 路径曾扫全量 args（含文件内容），gate 只扫目标路径——白名单写入正文含敏感词会被误拒，破坏零评审契约并让矛盾对哨兵误报。共享 `denyHaystackFor()`（文件工具→仅路径、bash→命令文本）现同时支撑 gate 与 approval。
- **提权文件工具调用把目标路径传给分类器**（`PromptInput.paths`）：此前提权 `write` 仅凭理由文本被评判（文件工具无 command）。
- `toolArgsKey` 目录改 JSON 序列化（逗号拼接可碰撞）；`warnSetterMissing` 按 setter 名跟踪；`reasoning effort` 子串匹配收紧；清理死导入 `classifyBand`；补正 spec 虚记的测试声明；新增文件工具签名奇偶性回归测试（记录 gate↔approval reason 模板耦合）。

### 变更（0.14.3 工作，未单独发布）
- **权限 setter 改为运行时探测**（[issue #1](https://github.com/log-li/dsh-automode/issues/1)，xiaolinziwang）：`setApprovalPolicy` / `setSandboxMode` 改 namespace import + `typeof` 探测。缺失时 auto mode **降级**（跳过 + 一次性警告）而非崩溃。
- **兼容层加固**（0.14.2 工作，未单独发布）：
- **权限 setter 也改为运行时探测**（[issue #1](https://github.com/log-li/dsh-automode/issues/1)，xiaolinziwang）：`setApprovalPolicy` / `setSandboxMode` 改为 namespace import + `typeof` 探测，不再命名导入。新宿主（Desktop 2.0.5 系）整体移除了这些导出——命名导入会在模块实例化期崩溃。setter 缺失时 auto mode **降级**（跳过该 knob + 一次性警告）而非崩溃。
- **兼容层加固**（0.14.2 工作，未单独发布）：`permission-state.ts` 对 legacy `effective*` 导出改用 **namespace import + 运行时 `typeof` 探测**（思路采纳自 [WSL043 的 PR #2](https://github.com/log-li/dsh-automode/pull/2)）。在新版 Harness build / 官方 npm 包**整体移除** `effectivePermissionPreset` 等导出的宿主上，插件加载不再在模块实例化期崩溃；探测不到的 fold 直接跳过事件日志回退（投影路径不变）。保留我们的 fail-soft `{}` 行为（未采纳 PR 的 `throw`）。
- 贡献署名：`package.json` `contributors` 增加 WSL043；实现 commit 带 `Co-authored-by`。

### 致谢
- @WSL043 — [PR #2](https://github.com/log-li/dsh-automode/pull/2)：权限兼容层的 namespace-import + 运行时探测思路（v0.14.2 commit 共同署名，已列入包元数据）。
- @xiaolinziwang — [issue #1](https://github.com/log-li/dsh-automode/issues/1)：报告 Desktop 2.0.5 移除权限 setter 导出，促成降级不崩的修复。

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
