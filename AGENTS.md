# AGENTS.md — dsh-automode

DSH 生态插件：**自主审批（auto mode）**——确定性频带 + pre-execute 门 + 两阶段分类器，
在工具调用**执行前**裁决 `allow` / `reject`；危险动作被拦下、改写或转人工。

**设计真相见 spec**：`.plans/spec/dsh-automode-spec.md `（活文档：文件名不带日期、不搬家）
—— 改行为前先读它，改完先把 spec 更新到位再继续写代码（全局「Spec 先行规则」）。

## 形态

- **host 半边插件，无 client 半边**：`package.json` 的 `dsh.bundle.patch: ./cordis.patch.yml` 挂载自身，
  加入 profile 的 `dsh.profile.bundles` 即生效。**同一入口只能有一条注册路径**——bundle 路径与
  `cordis.patch.yml` 里手写 `insert` 不得同时存在（`duplicate loader entry id` 会启动即崩）。
- **peer 范围**：`@deepseek-ai/dsh-*` 为 `>=0.1.0-rc.6 <0.2.0`。**`≥0.2.0` 未验证**——只有对新内核
  实测通过后才上调（见 spec §版本支持声明）。
- **权限事实双探测**：`0.1.0-rc.6–0.1.4.x` 读会话事件日志，`≥0.1.5-rc.1` 读会话权限投影；
  兼容层用 namespace-import + 运行时 `typeof` 探测，**不在模块加载期假定宿主导出存在**
  （宿主移除 legacy 导出会直接拖垮整个 plugin tree）。

## 硬约束（违反即偏离 spec）

1. **二态契约**：分类器只输出 `{"decision":"allow"|"reject","reason":"…"}`；**不确定即 reject**
   （fail-closed：误放不可逆，误拒可重试或转人工）；老模型输出 `ask` 归一为 reject。
2. **确定性层先于 LLM**：deny 频带（正则硬拒）最先执行；`allowPaths` 是**用户显式声明的全信任**，
   只免本插件评审，**不改变 DSH 文件沙箱**对 workspace 外路径的写权限。
3. **只扫「操作」，不扫「散文」**：频带与信任证明只看命令 / 目标路径；**stage-1 预筛的输入必须带
   命令原文**（只给工具名 + justification 会让结构化审查被整段绕过，且绕过方向是误放）。
4. **不干预非 auto-mode**：read-only / workspace-write / danger-full-access 一律放行，不与用户所选
   沙箱或审批预设冲突。
5. **模型无关 + 安全回退**：分类器路由可指向任意模型；`classifier.provider/model` 为空时跟随会话
   实际模型，且路由不支持 `reasoningEffort`（宿主抛 `UNSUPPORTED_REASONING_EFFORT`）时必须安全回退。

## 结构

```
src/
  index.ts            主入口：preset、approval answerer（decideAuto）、熔断器复位、/auto(-status)、系统提示注入
  bands.ts            确定性频带（deny 正则 / allow 前缀 glob / 复合 shell 分段 + 写目标提取）
  pre-execute.ts      pre-execute 门（第①道防线，仅 auto-mode 会话生效）
  classifier.ts       两阶段分类器（预筛 + 结构化裁决 + 鲁棒解析 + 裁决缓存签名）
  prompt.ts / rules.ts / cache.ts / breaker.ts / bridge.ts / permission-state.ts / config.ts / log.ts
lib/                  构建产物（**入库**，运行时读这里）
scripts/              smoke / bridge-flow / compose-entries / path-trust / privacy-check / release-notes / e2e（含 e2e-v4-migration）
```

## 命令

```bash
npm run build         # src → lib；**lib/ 入库，改 src 后必须 build 并一起提交**
npm run typecheck
npm test              # smoke：含 README 政策措辞守卫 + CHANGELOG 当前版本段守卫 + Release notes 双语断言 + tracked 树隐私断言
npm run test:flow     # approval 桥接流程
npm run test:compose  # 复合命令写目标提取
npm run test:pathtrust
npm run test:v4       # opt-in：真实 v3 会话日志在「新会话格式」上重开 + 注入标识归一 + 退役形态红对照
                      # 需要 DSH_V4_NODE_MODULES 指向 ≥ v4 的 DSH 安装（本机在用实例低于 v4 时自动 SKIP 给指引）
npm run check:privacy
npm run release:notes
```

## 治理（对齐行业惯例；细则见 spec §项目治理规范）

- **Commit**：Conventional Commits 1.0（`fix`→PATCH、`feat`→MINOR、`BREAKING CHANGE:`→MAJOR）。
- **CHANGELOG**：**单文件双语**——上半英文、下半中文（`---` 分隔，**两半都要改**，不按版本交错）；
  **简洁优先**：只写「变化了什么、对使用者意味着什么」，**不写工作过程**（验证步骤、日志证据、
  测试计数、review 轮次、内部函数名与文件名一律归 spec 与 commit）。
- **Release notes 必须双语**：抽取逻辑只此一份 = `scripts/release-notes.mjs`，workflow 与手动刷新都调它
  （不要另写切片命令）；`npm test` 有断言钉死。
- **隐私门禁在 commit 前**（git 历史不可撤销，事后中性化抹不掉旧 commit）：`npm run check:privacy`；
  `.githooks/pre-commit` 以 `--staged` 在同一道闸拦截（每 clone 启用一次：
  `git config core.hooksPath .githooks`）。**写文档时不要粘贴含本机绝对路径的原始输出**
  （真机证据改写为 `~`、`/Users/<user>` 或占位符）。
- **文档 == 行为**：语义 / 行为 / 配置变化 → 逐段重读 README 中英 + CHANGELOG 对应段；能被测试卡住的
  就不要靠记忆（`npm test` 已有机械守卫）。
- **Review 门禁**：代码写完、**开始验证之前**，做一次**独立模型家族**的 code review（无【严重】级问题
  才进入验证）；review 意见逐条独立核验，误报可拒绝并写明理由。
- **E2E 门禁在 commit 前（且必须独立实例，2026-09-23 用户明确）**：顺序固定为
  `写代码 → 独立 review → 按 review 修正 → 端到端验证（绿）→ commit → push`；**E2E 没过不许 commit**。
  E2E ＝ 在**真实运行环境**里启动插件并走一遍真实路径、**读回真实产物**（会话日志 / decisions.jsonl /
  模型可见输出），不是只跑 smoke/fixture 的那一层。
  **不要用当前在用的实例验证**（正在跑的 web profile / 本次会话所在的运行时）——它结果不可信（很可能加载的
  是旧版）、还会污染正在做的事。做法：`DSH_HOME=/tmp/<隔离目录>` + 独立 profile + 独立 cordis.patch.yml，
  用完清理。能构造失败面就做**红绿对照**（先复现旧版失败，再验证新版通过）。
  验证边界必须如实写进 spec 与回复（哪些层是活体 E2E、哪些层只是代码路径/离线验证）。
- **新决策先落 spec**：设计迭代的结论进 `.plans/spec/dsh-automode-spec.md`（含变更历史），
  一次性方案快照才进 `.plans/proposed/` → 实现后移 `.plans/implemented/`。

## 发布

推 tag 即触发 Actions：

```bash
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

`.github/workflows/release.yml`：build + smoke + bridge-flow 全过 → `npm publish` → 自动创建
GitHub Release（notes 由 `scripts/release-notes.mjs` 从 CHANGELOG 抽取，双语）。
发布前置：CHANGELOG 两个半区定稿（去掉 `unreleased`）+ 独立 review 完成 + README/CHANGELOG 与实现逐段对齐。
详见 spec §发布流程。
