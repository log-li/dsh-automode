import * as presets from '@deepseek-ai/dsh-permission-presets';
import * as approval from '@deepseek-ai/dsh-user-approval';
import * as sandbox from '@deepseek-ai/dsh-sandbox-policy';
const legacy = (module, name) => {
    const value = module[name];
    return typeof value === 'function' ? value : undefined;
};
export function permissionPreset(ctx, session) {
    const service = ctx?.get('permissionPresets');
    if (typeof service?.current === 'function')
        return service.current(session);
    const fold = legacy(presets, 'effectivePermissionPreset');
    if (fold)
        return fold(session.events);
    throw new Error('dsh-automode: permissionPresets.current is unavailable; cannot determine the active preset');
}
export function approvalPolicy(ctx, session) {
    const service = ctx.get('approval');
    if (typeof service?.effectivePolicy === 'function')
        return service.effectivePolicy(session);
    const fold = legacy(approval, 'effectiveApprovalPolicy');
    if (fold)
        return fold(session.events);
    throw new Error('dsh-automode: approval.effectivePolicy is unavailable');
}
export function sandboxMode(ctx, session) {
    const service = ctx.get('sandboxPolicy');
    if (typeof service?.resolve === 'function')
        return service.resolve({ session }).mode;
    const fold = legacy(sandbox, 'effectiveSandboxMode');
    if (fold)
        return fold(session.events);
    throw new Error('dsh-automode: sandboxPolicy.resolve is unavailable');
}
export const hasLegacyPermissionFolds = () => ['effectivePermissionPreset'].every(name => legacy(presets, name) !== undefined)
    && legacy(approval, 'effectiveApprovalPolicy') !== undefined
    && legacy(sandbox, 'effectiveSandboxMode') !== undefined;
