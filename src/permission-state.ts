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
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';

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

/** Event-log shape the pre-0.1.5 helpers accept. */
type PermissionEvents = Parameters<typeof effectivePermissionPreset>[0];

/** The 0.1.5+ projection read we depend on (`stateOf` is newer than our peer floor). */
interface ProjectionReader {
  stateOf?: (session: Session, key: string) => unknown;
}

/**
 * Read one session's durable permission facts.
 *
 * Prefers the `permissions` session projection (dsh >= 0.1.5-rc.1) and falls
 * back to the event log for older cores.
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

  const events = (session as unknown as { events?: PermissionEvents }).events;
  if (events !== null && events !== undefined) {
    return {
      preset: effectivePermissionPreset(events),
      sandbox: effectiveSandboxMode(events),
      approval: effectiveApprovalPolicy(events),
    };
  }

  return {};
}
