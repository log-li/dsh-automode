// namespace imports + runtime probe (v0.14.2): never a load-time dependency on
// exports that newer hosts may have removed.
import * as presets from '@deepseek-ai/dsh-permission-presets';
import * as approvalModule from '@deepseek-ai/dsh-user-approval';
import * as sandboxModule from '@deepseek-ai/dsh-sandbox-policy';
/** Projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions';
/**
 * Runtime-probe a legacy fold helper on a namespace module (v0.14.2, PR #2
 * approach). A named import would crash at load time on hosts that removed the
 * export; probing keeps loading safe and returns undefined when the helper is
 * gone — callers then skip the event-log fallback.
 */
export function legacyFold(module, name) {
    if (module === null || typeof module !== 'object')
        return undefined;
    const value = module[name];
    return typeof value === 'function' ? value : undefined;
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
export function permissionSnapshot(ctx, session) {
    // Cast through `unknown`: the projection registry only exists on cores that
    // ship it, and this plugin does not depend on its type package directly.
    const registry = ctx.sessionProjections;
    if (typeof registry?.stateOf === 'function') {
        const state = registry.stateOf(session, PERMISSIONS_KEY);
        if (state !== null && state !== undefined)
            return state;
    }
    const events = session.events;
    if (events !== null && events !== undefined) {
        const presetFold = legacyFold(presets, 'effectivePermissionPreset');
        const sandboxFold = legacyFold(sandboxModule, 'effectiveSandboxMode');
        const approvalFold = legacyFold(approvalModule, 'effectiveApprovalPolicy');
        return {
            preset: presetFold ? presetFold(events) : null,
            sandbox: sandboxFold ? sandboxFold(events) : null,
            approval: approvalFold ? approvalFold(events) : null,
        };
    }
    return {};
}
/** The preset name this plugin owns (`cordis.patch.yml` → `presets.auto-mode`). */
const AUTO_MODE_PRESET = 'auto-mode';
/** How far up the `header.parentSession` chain the inheritance walk goes. */
const MAX_INHERITANCE_DEPTH = 4;
/**
 * Resolve one session by id through the host registry.
 *
 * Prefers the durable `sessions` store (works for sessions that are not live);
 * falls back to the live `agents` registry. Both are probed at runtime because
 * this plugin does not declare either service in its `inject` list — a missing
 * service must degrade to "not resolvable", never to a load-time failure.
 */
function sessionById(ctx, id) {
    const host = ctx;
    if (typeof host.get !== 'function')
        return undefined;
    try {
        const store = host.get('sessions');
        const found = store?.get?.(id);
        if (found)
            return found;
    }
    catch {
        /* probe only */
    }
    try {
        const agents = host.get('agents');
        const live = agents?.get?.(id)?.session;
        if (live)
            return live;
    }
    catch {
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
export function autoModeCoverage(ctx, session) {
    const own = permissionSnapshot(ctx, session).preset;
    if (own === AUTO_MODE_PRESET)
        return { covered: true, via: 'self' };
    // The session's OWN recorded identity wins over an ancestor's: a user who
    // switched this session (or a host that propagated a built-in identity such as
    // `danger-full-access`) chose a different preset, and the gate must not override
    // it. Only a session with NO preset of its own inherits (v0.18.0 review).
    if (own !== null && own !== undefined)
        return { covered: false, via: 'none' };
    const header = session.header;
    const isDelegated = header?.origin === 'subagent'
        || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0);
    if (!isDelegated)
        return { covered: false, via: 'none' };
    let cursor = header;
    for (let depth = 0; depth < MAX_INHERITANCE_DEPTH; depth++) {
        const parentId = cursor?.parentSession;
        if (!parentId)
            break;
        const parent = sessionById(ctx, parentId);
        // A delegated session whose parent cannot be resolved is NOT covered (the
        // historical behaviour), but the caller records it: a stale parent id must
        // not make coverage disappear without a trace.
        if (!parent)
            return { covered: false, via: 'unresolved' };
        if (permissionSnapshot(ctx, parent).preset === AUTO_MODE_PRESET) {
            return { covered: true, via: 'ancestor', ancestorSessionId: String(parentId) };
        }
        cursor = parent.header;
    }
    return { covered: false, via: cursor?.parentSession ? 'unresolved' : 'none' };
}
