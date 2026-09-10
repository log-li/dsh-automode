import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';
/** Projection key owned by `@deepseek-ai/dsh-permission-presets`. */
const PERMISSIONS_KEY = 'permissions';
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
        return {
            preset: effectivePermissionPreset(events),
            sandbox: effectiveSandboxMode(events),
            approval: effectiveApprovalPolicy(events),
        };
    }
    return {};
}
