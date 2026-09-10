import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import * as presets from '@deepseek-ai/dsh-permission-presets';
import * as approval from '@deepseek-ai/dsh-user-approval';
import * as sandbox from '@deepseek-ai/dsh-sandbox-policy';

// Namespace imports also link on projection-based hosts, where the old
// event-fold exports no longer exist. Never reconstruct current state from
// session.events on those hosts: defaults and seeded history belong to services.
type LegacyFold = (events: Session['events']) => string | undefined;
const legacy = (module: object, name: string): LegacyFold | undefined => {
  const value = (module as Record<string, unknown>)[name];
  return typeof value === 'function' ? value as LegacyFold : undefined;
};

export function permissionPreset(ctx: Context | undefined, session: Session): string | undefined {
  const service = ctx?.get('permissionPresets') as { current?(session: Session): string } | undefined;
  if (typeof service?.current === 'function') return service.current(session);
  const fold = legacy(presets, 'effectivePermissionPreset');
  if (fold) return fold(session.events);
  throw new Error('dsh-automode: permissionPresets.current is unavailable; cannot determine the active preset');
}

export function approvalPolicy(ctx: Context, session: Session): ApprovalPolicy | undefined {
  const service = ctx.get('approval') as { effectivePolicy?(session: Session): ApprovalPolicy } | undefined;
  if (typeof service?.effectivePolicy === 'function') return service.effectivePolicy(session);
  const fold = legacy(approval, 'effectiveApprovalPolicy');
  if (fold) return fold(session.events) as ApprovalPolicy | undefined;
  throw new Error('dsh-automode: approval.effectivePolicy is unavailable');
}

export function sandboxMode(ctx: Context, session: Session): string | undefined {
  const service = ctx.get('sandboxPolicy') as { resolve?(request: { session: Session }): { mode: string } } | undefined;
  if (typeof service?.resolve === 'function') return service.resolve({ session }).mode;
  const fold = legacy(sandbox, 'effectiveSandboxMode');
  if (fold) return fold(session.events);
  throw new Error('dsh-automode: sandboxPolicy.resolve is unavailable');
}

export const hasLegacyPermissionFolds = (): boolean =>
  ['effectivePermissionPreset'].every(name => legacy(presets, name) !== undefined)
  && legacy(approval, 'effectiveApprovalPolicy') !== undefined
  && legacy(sandbox, 'effectiveSandboxMode') !== undefined;
