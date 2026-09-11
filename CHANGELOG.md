# Changelog

All notable changes to **@log.li/dsh-automode** since the previous release (0.12.0).

## [0.14.2] — unreleased

### Changed
- **Compatibility layer hardened against hosts that removed the legacy `effective*` exports** (adopted from [PR #2 by WSL043](https://github.com/log-li/dsh-automode/pull/2)): `permission-state.ts` now loads those helpers via **namespace import + runtime `typeof` probing** instead of named imports. On newer Harness builds / official npm packages where `effectivePermissionPreset` & co are removed entirely, plugin loading no longer fails at module-instantiation; a missing fold simply skips the event-log fallback (projection path unchanged). Our fail-soft `{}` behavior is kept (the PR's `throw` was not adopted).

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
