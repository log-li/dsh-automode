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

/** The preset name this plugin owns (`cordis.patch.yml` → `presets.auto-mode`). */
const AUTO_MODE_PRESET = 'auto-mode';

/** How far up the `header.parentSession` chain the inheritance walk goes. */
const MAX_INHERITANCE_DEPTH = 4;

/** Which session supplied the auto-mode identity for a gate decision. */
export interface AutoModeCoverage {
  /** Whether the pre-execute gate must run for this session. */
  readonly covered: boolean;
  /**
   * `self` = the session's own preset; `ancestor` = inherited; `none` = covered by
   * neither; `unresolved` = a delegated session whose ancestry cannot be walked
   * (parent not resident / store unavailable / depth exhausted) — same decision as
   * `none`, but recorded in the audit trail instead of failing silently.
   */
  readonly via: 'self' | 'ancestor' | 'none' | 'unresolved';
  /** The ancestor session whose preset covered this one (`via === 'ancestor'`). */
  readonly ancestorSessionId?: string;
}

/** The services we probe for an id → session lookup (both optional). */
interface SessionLookupHost {
  get?: (name: string, strict?: boolean) => unknown;
}

/**
 * Resolve one session by id through the host registry.
 *
 * Prefers the durable `sessions` store (works for sessions that are not live);
 * falls back to the live `agents` registry. Both are probed at runtime because
 * this plugin does not declare either service in its `inject` list — a missing
 * service must degrade to "not resolvable", never to a load-time failure.
 */
function sessionById(ctx: Context, id: string): Session | undefined {
  const host = ctx as unknown as SessionLookupHost;
  if (typeof host.get !== 'function') return undefined;
  try {
    const store = host.get('sessions') as { get?: (sid: string) => Session | undefined } | undefined;
    const found = store?.get?.(id);
    if (found) return found;
  } catch {
    /* probe only */
  }
  try {
    const agents = host.get('agents') as { get?: (sid: string) => { session?: Session } | undefined } | undefined;
    const live = agents?.get?.(id)?.session;
    if (live) return live;
  } catch {
    /* probe only */
  }
  return undefined;
}

/**
 * Whether this session is governed by auto mode — directly or through a parent.
 *
 * A subagent/teammate session is created with its OWN permission projection;
 * the host only propagates its built-in `auto` / `danger-full-access`
 * identities into children, so a third-party preset like `auto-mode` never
 * reaches them (and their approval policy is pinned to `never`). Without the
 * ancestry walk the gate silently no-ops for every spawned agent — the gap
 * reported in issue #4.
 *
 * Only DELEGATION lineage counts: `header.parentSession` is shared with forked
 * sessions ("seed lineage"), and a fork is a copy of a conversation the user
 * reopens under their own chosen preset — enforcing auto mode on it because its
 * source session was in auto mode would override that choice. The host marks
 * delegations with `origin: 'subagent'` and a positive `delegationDepth`;
 * anything else is treated as not delegated.
 *
 * Failure direction: an unresolvable ancestor chain means "not covered", i.e.
 * the historical behaviour. That keeps unrelated sessions untouched instead of
 * enforcing on a session whose lineage cannot be established.
 */
export function autoModeCoverage(ctx: Context, session: Session): AutoModeCoverage {
  const own = permissionSnapshot(ctx, session).preset;
  if (own === AUTO_MODE_PRESET) return { covered: true, via: 'self' };
  // The session's OWN recorded identity wins over an ancestor's: a user who
  // switched this session (or a host that propagated a built-in identity such as
  // `danger-full-access`) chose a different preset, and the gate must not override
  // it. Only a session with NO preset of its own inherits (v0.18.0 review).
  if (own !== null && own !== undefined) return { covered: false, via: 'none' };

  type Header = { parentSession?: string; origin?: string; delegationDepth?: number };
  const header = (session as unknown as { header?: Header }).header;
  const isDelegated = header?.origin === 'subagent'
    || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0);
  if (!isDelegated) return { covered: false, via: 'none' };

  let cursor: Header | undefined = header;
  for (let depth = 0; depth < MAX_INHERITANCE_DEPTH; depth++) {
    const parentId = cursor?.parentSession;
    if (!parentId) break;
    const parent = sessionById(ctx, parentId);
    // A delegated session whose parent cannot be resolved is NOT covered (the
    // historical behaviour), but the caller records it: a stale parent id must
    // not make coverage disappear without a trace.
    if (!parent) return { covered: false, via: 'unresolved' };
    if (permissionSnapshot(ctx, parent).preset === AUTO_MODE_PRESET) {
      return { covered: true, via: 'ancestor', ancestorSessionId: String(parentId) };
    }
    cursor = (parent as unknown as { header?: Header }).header;
  }
  return { covered: false, via: cursor?.parentSession ? 'unresolved' : 'none' };
}
