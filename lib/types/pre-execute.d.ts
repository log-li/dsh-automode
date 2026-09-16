/**
 * Pre-execute gate — the first enforcement point for ALL tool calls.
 *
 * Runs before the approval/request waterfall. Catches:
 *   1. Read-only tools → allow (unless deny matched)
 *   2. Deny patterns (regex) → hard reject
 *   3. Allow patterns (prefix glob) → approve
 *   4. allowInsideWorkingDirectory → in-tree file ops approve
 *   5. Escalation intent (sandbox_permissions) → decideRoute → classifier
 *
 * The denial reason reaches the model verbatim via {kind:"deny", reason},
 * unlike the approval waterfall which uses a generic sandbox template.
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ConfigType } from './config.js';
import { VerdictCache } from './cache.js';
import { Breaker } from './breaker.js';
import { AllowPathBridge } from './bridge.js';
/** Whether `p` (symlink-resolved) is under any trust root.
 * Relative paths are resolved against `base` (the session working directory)
 * before the realpath/prefix match — the host process cwd must never be the
 * resolution base for a session-relative file-tool path, or every in-workspace
 * relative path (e.g. `_internal/log.md`) is misjudged out-of-tree (2026-09-01
 * Bug A; see spec). Without `base`, behavior is the legacy process-cwd resolve. */
export declare function isInsideTrusted(p: string, roots: string[], base?: string): boolean;
/**
 * Injected at the moment the breaker trips so the model stops doing the
 * "try at current level → hit a denied error → then escalate" round-trip
 * and instead requests the sandbox escalation directly, surfacing the human
 * approval window immediately.
 *
 * v0.15.3: the hint also scopes "a human decides" to the paused state. While the
 * breaker is tripped the gate deliberately skips the allowPath branch (and so
 * records no approval bridge), which is why escalation really does reach a human
 * here — but the old wording ("a human will be asked to approve it") read as if
 * escalation *always* queues for a human, which is false for allowlisted targets
 * in normal operation and pushes the model to avoid escalating at all.
 */
export declare const BREAKER_TRIPPED_HINT: string;
export interface PreExecuteResult {
    kind: 'allow' | 'deny';
    reason?: string;
}
/**
 * Register the pre-execute gate as a tools/pre-execute listener.
 */
export declare function registerPreExecute(ctx: Context, config: ConfigType, cache: VerdictCache, breaker: Breaker, logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
}, bridge: AllowPathBridge): void;
