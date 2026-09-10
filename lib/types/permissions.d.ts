import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
export declare function permissionPreset(ctx: Context | undefined, session: Session): string | undefined;
export declare function approvalPolicy(ctx: Context, session: Session): ApprovalPolicy | undefined;
export declare function sandboxMode(ctx: Context, session: Session): string | undefined;
export declare const hasLegacyPermissionFolds: () => boolean;
