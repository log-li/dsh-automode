/**
 * LLM classifier: renders the conversation transcript, streams one
 * classifier call through `ctx.llm`, and parses the JSON verdict.
 *
 * The classifier is fail-aware but not fail-closed by itself: it returns
 * `null` when no verdict can be produced (API error, aborted stream,
 * truncated or unparsable reply), and the caller decides what `null` means
 * (`failClosed` config, or falling back to the human approval chain).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Message } from '@deepseek-ai/dsh-llm';
/** A classifier decision: allow or reject (two-state; ask was removed in 0.8.0). */
export type VerdictDecision = 'allow' | 'reject';
/** A parsed classifier verdict. */
export interface Verdict {
    /** The decision. */
    readonly decision: VerdictDecision;
    /** The classifier's one-sentence justification. */
    readonly reason: string;
}
/** A classifier stream failure (error finish or thrown), for diagnostics. */
export interface ClassifyFailure {
    /** Error message from the provider/adapter. */
    readonly message: string;
    /** Adapter error code when present (e.g. UNSUPPORTED_REASONING_EFFORT). */
    readonly code?: string | null;
}
/**
 * Classify a classifier failure `detail` into a stable category so the * user-facing "unavailable" text can distinguish CONFIGURATION problems
 * (wrong route / unsupported reasoning effort — fixing the config or the
 * metadata is the remedy, retrying is not) from TRANSIENT ones (429 / 5xx /
 * timeout — retrying later is the remedy). v0.14.0: the previous free-text
 * sniffing lumped e.g. `UNSUPPORTED_REASONING_EFFORT` (ollama metadata
 * missing, retry-without-effort still cannot work) under "temporarily
 * unavailable", misleading the model into pointless retries.
 */
export type ClassifyFailureCategory = 'config:no-route' | 'config:unsupported-effort' | 'transient:timeout' | 'transient:rate-limit' | 'transient:overload' | 'transient:server' | 'transient:connection' | 'unknown';
/** Map a classifier-failure detail string to its stable category. */
export declare function classifyFailureCategory(detail: string): ClassifyFailureCategory;
/** Per-attempt classifier failure info delivered to the durable audit log. */
export interface ClassifyAttemptFailInfo {
    readonly stage: 'fast-filter' | 'review';
    /** The reasoning effort this attempt used, or null for the no-effort retry. */
    readonly effort: string | null;
    readonly failure: ClassifyFailure;
    /** Raw text accumulated before the failure (usually empty). */
    readonly raw: string;
}
/** Options for one classifier call. */
export interface ClassifyOptions {
    /** System prompt (see prompt.ts). */
    readonly system: string;
    /** User message: transcript + action (see prompt.ts). */
    readonly user: string;
    /** Provider route for the call (already resolved). */
    readonly provider: string;
    /** Model id for the call (already resolved). */
    readonly model: string;
    /** Sampling temperature. */
    readonly temperature: number;
    /** Output token budget. */
    readonly maxTokens: number;
    /** Cancellation signal (the approval request's signal). */
    readonly signal?: AbortSignal;
    /** Hard timeout (ms) applied to the classifier call; see effectiveSignal(). */
    readonly timeoutMs?: number;
    /** Optional adapter reasoning effort (low/medium/high); falls back if the route doesn't support it. */
    readonly reasoningEffort?: string;
    /** Optional logger for classifier root-cause diagnostics (route, errors, raw output). */
    readonly logger?: {
        info: (m: string) => void;
        warn: (m: string) => void;
    };
    /**
     * Optional per-attempt failure callback for durable diagnostics (decisions.jsonl).
     * Fired for EVERY failed stream attempt (error finish or thrown exception),
     * including attempts that are retried without effort.
     */
    readonly onAttemptFail?: (info: ClassifyAttemptFailInfo) => void;
}
/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export declare function renderTranscript(messages: readonly Message[], maxMessages: number): string;
/**
 * Restore the raw arguments of ONE specific tool call, matched by its callId
 * (v0.13.0, cache-signature parity fix).
 *
 * The `approval/request` payload deliberately omits arguments
 * (`ApprovalRequest` in dsh-user-approval: "callId links to an already
 * presented tool call, so arguments are not duplicated here"), so `decideAuto`
 * previously signed the verdict cache with the escalation-reason text while
 * the pre-execute gate signed with the real command text — the keys never
 * matched, every approval-path lookup missed, and a SECOND classifier run with
 * LESS information overrode the gate's better-informed verdict.
 *
 * The exact tool call is still in the session when the approval is decided, so
 * we recover its `arguments` here to keep both signatures identical. Returns
 * the parsed arguments object (same shape the pre-execute gate passes, i.e. an
 * object whose `command` is the command text), or `undefined` when the call is
 * outside the window or unparseable — callers then fall back to the legacy
 * reason-based signature (no worse than before).
 */
export declare function restoreToolCallArgs(messages: readonly Message[], callId: string | undefined): unknown;
/**
 * Render the user's RECENT explicit instructions (CC-style intent).
 *
 * Unlike the full transcript, this keeps only the most recent `maxMessages`
 * user-role messages, so the classifier can weigh what the user asked for
 * when judging whether an action serves the current request. Standalone
 * assistant/tool turns are dropped on purpose: repository text and tool
 * output MUST NOT grant permission (only direct human messages can).
 *
 * One exception (spec 2026-08-31): the user's answer to an
 * `ask_user_question` tool call IS a direct human authorization given through
 * the tool — it is folded into the intent window (as a `user:` line) so the
 * verdict-cache signature changes and a stale DENY no longer swallows a
 * fresh tool-based grant (M-34: every verdict input belongs in the cache key).
 */
export declare function renderUserIntent(messages: readonly Message[], maxMessages: number): string;
/** Truncate a rendered context block to a char budget (classifyContextChars). */
export declare function truncateToChars(text: string, maxChars: number): string;
/**
 * Resolve the classifier route: explicit config wins, otherwise the SESSION's
 * current request header (the model the user is actually running), otherwise
 * the agent's configured options. This lets the classifier follow the model the
 * session uses rather than a stale/default one.
 */
export declare function resolveRoute(agent: Agent, configuredProvider: string, configuredModel: string): {
    provider: string;
    model: string;
};
/**
 * Model-agnostic robust verdict parser (v0.5.0).
 *
 * Accepts strict JSON, markdown-fenced JSON, prose with keywords, and
 * alternate key names (verdict, safe/allow/deny/block booleans). Falls
 * back to keyword detection on the full text. Only returns null when
 * there is genuinely no signal at all.
 *
 * CRITICAL: deny patterns are checked BEFORE allow because "unsafe"
 * contains "safe" as a substring — checking allow first would misparse
 * UNSAFE verdicts as ALLOW.
 */
export declare function parseVerdict(reply: string): Verdict | null;
/**
 * One-token fast filter (stage 1 of two-stage classification).
 *
 * Sends a minimal prompt asking for a single digit: 0 = safe, 1 = needs
 * review. Costs ~1 token. Most routine actions return 0 (safe) and skip
 * the expensive structured review. Only actions that return 1 proceed to
 * the full `classify()` call.
 *
 * Returns true if the action needs review, false if safe, null on failure.
 */
export declare function fastFilter(ctx: Context, actionSummary: string, provider: string, model: string, signal?: AbortSignal, timeoutMs?: number, reasoningEffort?: string, logger?: {
    info: (m: string) => void;
    warn: (m: string) => void;
}, onAttemptFail?: (info: ClassifyAttemptFailInfo) => void): Promise<boolean | null>;
/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export declare function classify(ctx: Context, options: ClassifyOptions): Promise<Verdict | null>;
/**
 * Two-stage classification (spec decision chain, and README "two-stage
 * classifier"): run the cheap one-token fast filter first; only flagged or
 * failed-filter actions proceed to the full structured review.
 *
 * - fastFilter returns `false`  → routine/safe → ALLOW (no full review).
 * - fastFilter returns `true`   → needs review → full classify().
 * - fastFilter returns `null`   → filter failed → be conservative: run the
 *   full classify() (fail-closed upstream decides what a null verdict means).
 *
 * This is what wires the previously-dead `fastFilter` (Bug 1) into both the
 * approval waterfall and the pre-execute escalation pre-screen.
 */
export declare function classifyTwoStage(ctx: Context, options: ClassifyOptions, actionSummary: string): Promise<Verdict | null>;
