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
