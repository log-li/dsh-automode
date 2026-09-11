/**
 * Durable permission facts for one session (dsh core compatibility layer).
 *
 * Why this module exists
 * ----------------------
 * dsh 0.1.5-rc.1 removed the `session.events` accessor. Reading it now yields
 * `undefined`, so the historical `effectivePermissionPreset(session.events)`
 * call dies with
 *
 *   TypeError: Cannot read properties of undefined (reading 'length')
 *
 * Because this plugin renders the current policy into every turn's system
 * prompt (`approval:policy` context), that throw landed inside
 * `systemPrompt.assemble()` during `agent/pre-step` — every single message of
 * every auto-mode session failed with "本轮运行失败". The bug only surfaced at
 * runtime (never at import time), so it read as "the whole harness is broken".
 *
 * The supported read path on 0.1.5+ is the durable `permissions` session
 * projection — the same fold the core `dsh-permission-presets` service reads
 * through `current()`. Cores that still expose the event log keep working via
 * the log helpers, so the plugin spans its whole declared peer range.
 *
 * v0.14.2 (adopts PR #2, WSL043): the legacy event-fold helpers
 * (`effectivePermissionPreset` / `effectiveApprovalPolicy` /
 * `effectiveSandboxMode`) were once NAMED imports here. Newer Harness builds /
 * official npm packages REMOVE those exports entirely — on such hosts a named
 * import fails at module instantiation even though the runtime path never uses
 * the helper (the projection is preferred). Switched to namespace imports +
 * runtime `typeof` probing, so loading never depends on an export that may be
 * gone; a missing fold simply skips the event-log fallback.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
/** One session's durable permission facts. A missing key was never recorded. */
export interface PermissionSnapshot {
    /** Last selected preset (`permission/preset`), else `null`. */
    preset?: string | null;
    /** Last set sandbox mode (`sandbox/mode`), else `null`. */
    sandbox?: string | null;
    /** Last set approval policy (`approval/policy`), else `null`. */
    approval?: ApprovalPolicy | null;
}
/**
 * Shape of the legacy event-log fold helpers (`effectivePermissionPreset` and
 * friends on pre-0.1.6 cores): fold the session event log into a value.
 */
export type LegacyFold = (events: unknown) => string | undefined;
/**
 * Runtime-probe a legacy fold helper on a namespace module (v0.14.2, PR #2
 * approach). A named import would crash at load time on hosts that removed the
 * export; probing keeps loading safe and returns undefined when the helper is
 * gone — callers then skip the event-log fallback.
 */
export declare function legacyFold(module: unknown, name: string): LegacyFold | undefined;
/**
 * Read one session's durable permission facts.
 *
 * Prefers the `permissions` session projection (dsh >= 0.1.5-rc.1) and falls
 * back to the event log for older cores (only when the legacy fold helpers are
 * still exported — v0.14.2 runtime-probes them and skips the fallback if gone).
 *
 * @param ctx - plugin context carrying the `sessionProjections` registry.
 * @param session - session whose permission facts are read.
 * @returns the recorded preset/sandbox/approval; `{}` when neither source exists.
 */
export declare function permissionSnapshot(ctx: Context, session: Session): PermissionSnapshot;
