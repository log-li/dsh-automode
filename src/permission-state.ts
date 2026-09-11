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
// namespace imports + runtime probe (v0.14.2): never a load-time dependency on
// exports that newer hosts may have removed.
import * as presets from '@deepseek-ai/dsh-permission-presets';
import * as approvalModule from '@deepseek-ai/dsh-user-approval';
import * as sandboxModule from '@deepseek-ai/dsh-sandbox-policy';

/** One session's durable permission facts. A missing key was never recorded. */
export interface PermissionSnapshot {
  /** Last selected preset (`permission/preset`), else `null`. */
  preset?: string | null;
  /** Last set sandbox mode (`sandbox/mode`), else `null`. */
  sandbox?: string | null;
  /** Last set approval policy (`approval/policy`), else `null`. */
  approval?: ApprovalPolicy | null;
}

/** Projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions';

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
export function legacyFold(module: unknown, name: string): LegacyFold | undefined {
  if (module === null || typeof module !== 'object') return undefined;
  const value = (module as Record<string, unknown>)[name];
  return typeof value === 'function' ? (value as LegacyFold) : undefined;
}

/** The 0.1.5+ projection read we depend on (`stateOf` is newer than our peer floor). */
interface ProjectionReader {
  stateOf?: (session: Session, key: string) => unknown;
}

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
export function permissionSnapshot(ctx: Context, session: Session): PermissionSnapshot {
  // Cast through `unknown`: the projection registry only exists on cores that
  // ship it, and this plugin does not depend on its type package directly.
  const registry = (ctx as unknown as { sessionProjections?: ProjectionReader }).sessionProjections;
  if (typeof registry?.stateOf === 'function') {
    const state = registry.stateOf(session, PERMISSIONS_KEY) as PermissionSnapshot | null | undefined;
    if (state !== null && state !== undefined) return state;
  }

  const events = (session as unknown as { events?: unknown }).events;
  if (events !== null && events !== undefined) {
    const presetFold = legacyFold(presets, 'effectivePermissionPreset');
    const sandboxFold = legacyFold(sandboxModule, 'effectiveSandboxMode');
    const approvalFold = legacyFold(approvalModule, 'effectiveApprovalPolicy');
    return {
      preset: presetFold ? presetFold(events) : null,
      sandbox: sandboxFold ? sandboxFold(events) : null,
      approval: approvalFold ? (approvalFold(events) as ApprovalPolicy | undefined) : null,
    };
  }

  return {};
}
