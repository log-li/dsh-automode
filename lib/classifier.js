import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** Map a classifier-failure detail string to its stable category. */
export function classifyFailureCategory(detail) {
    const m = detail.toLowerCase();
    if (/no classifier route/.test(m))
        return 'config:no-route';
    if (/unsupported[\s-]*reasoning[\s-]*effort|reasoning effort/.test(m))
        return 'config:unsupported-effort';
    if (/timed?\s*out|timeout|stalled/.test(m))
        return 'transient:timeout';
    if (/rate.?limit|429/.test(m))
        return 'transient:rate-limit';
    if (/overload|529/.test(m))
        return 'transient:overload';
    if (/server error|\b5\d\d\b/.test(m))
        return 'transient:server';
    if (/connect|network|socket|fetch failed|econn/.test(m))
        return 'transient:connection';
    return 'unknown';
}
/**
 * Combine a request cancellation signal with a hard timeout.
 * Uses AbortSignal.any/timeout (Node >= 20.3). Falls back to just the
 * request signal when no timeout is configured.
 */
function effectiveSignal(signal, timeoutMs) {
    if (timeoutMs != null && timeoutMs > 0) {
        const t = AbortSignal.timeout(timeoutMs);
        return signal ? AbortSignal.any([signal, t]) : t;
    }
    return signal;
}
/** Token budget for the one-token fast filter. Reasoning models consume budget
 * on chain-of-thought, so a tiny budget starves the answer and always degrades
 * to the full classifier; give enough headroom for a low-effort reasoning pass. */
const FAST_FILTER_MAX_TOKENS = 512;
/**
 * Shared streaming helper: runs one classifier call and accumulates text.
 *
 * If a reasoning effort was requested but the route does not support it, fall
 * back to a no-effort retry. Two failure shapes must both retry:
 *   1. `ctx.llm.stream` THROWS `UNSUPPORTED_REASONING_EFFORT` (config-time
 *      validation in dsh-llm), or
 *   2. the stream TERMINATES with an `error` finish chunk whose
 *      `reason.failure.code === 'UNSUPPORTED_REASONING_EFFORT'` (dispatch-time
 *      validation) — this shape does NOT throw, so the old catch-only fallback
 *      never fired and every effort-carrying call failed deterministically.
 * Every failed attempt (error finish or thrown) is reported through
 * `spec.onAttemptFail` for the durable audit log.
 *
 * Returns `{ text, reasonKind, failure }` on success or a terminal non-error
 * finish, or `null` on a hard failure after all attempts.
 */
async function streamTokens(ctx, spec) {
    const attempts = spec.reasoningEffort
        ? [spec.reasoningEffort, undefined]
        : [undefined];
    for (const effort of attempts) {
        let text = '';
        let reasonKind = null;
        let failure = null;
        try {
            for await (const chunk of ctx.llm.stream({
                provider: spec.provider,
                model: spec.model,
                system: spec.system,
                messages: [
                    createUserMessage({
                        content: [{ type: 'text', text: spec.user }],
                        source: { kind: 'plugin', plugin: 'auto-mode' },
                    }),
                ],
                temperature: spec.temperature,
                maxTokens: spec.maxTokens,
                signal: effectiveSignal(spec.signal, spec.timeoutMs),
                ...(effort !== undefined ? { reasoningEffort: effort } : {}),
            })) {
                if (chunk.type === 'text-delta')
                    text += chunk.text;
                else if (chunk.type === 'finish') {
                    reasonKind = chunk.reason?.kind ?? null;
                    const f = chunk.reason?.failure;
                    if (f?.message)
                        failure = { message: f.message, code: f.code ?? null };
                }
            }
            if (reasonKind === 'error') {
                // Terminal error finish — dispatch/validation failure, not a throw.
                if (failure) {
                    spec.logger?.warn(`classifier stream failed (${spec.provider}/${spec.model})${effort ? ` effort=${effort}` : ''}: ${failure.message}${failure.code ? ` [${failure.code}]` : ''}`);
                    spec.onAttemptFail?.({
                        stage: spec.stage ?? 'review',
                        effort: effort ?? null,
                        failure,
                        raw: text,
                    });
                }
                if (effort !== undefined)
                    continue; // retry without effort
            }
            return { text, reasonKind, failure };
        }
        catch (error) {
            if (error?.code === 'UNSUPPORTED_REASONING_EFFORT' &&
                effort !== undefined) {
                continue; // route doesn't support the effort → retry without it
            }
            const code = error?.code;
            const message = String(error?.message ?? error);
            spec.logger?.warn(`classifier stream failed (${spec.provider}/${spec.model})${effort ? ` effort=${effort}` : ''}: ${message}${code ? ` [${code}]` : ''}`);
            spec.onAttemptFail?.({
                stage: spec.stage ?? 'review',
                effort: effort ?? null,
                failure: { message, code: code ?? null },
                raw: text,
            });
            return null;
        }
    }
    return null;
}
/** Render one content block into plain text. */
function renderBlock(block) {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'reasoning':
            return `[thinking] ${block.text}`;
        case 'tool-call':
            return `[tool call: ${block.name} ${block.arguments}]`;
        case 'tool-result':
            return `[tool result${block.isError ? ' (error)' : ''}: ${block.content
                .map(renderBlock)
                .join(' ')}]`;
        case 'image':
            return '[image]';
        default:
            return '';
    }
}
/** Render one conversation message into a `role: content` line. */
function renderMessage(message) {
    const content = message.content.map(renderBlock).filter(Boolean).join(' ');
    return `${message.role}: ${content}`;
}
/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export function renderTranscript(messages, maxMessages) {
    const tail = messages.slice(Math.max(0, messages.length - maxMessages));
    return tail.map(renderMessage).join('\n\n');
}
/** toolCallId → tool name across the window, to recognize ask_user_question results. */
function toolNameByCallId(messages) {
    const names = new Map();
    for (const m of messages) {
        if (m.role !== 'assistant')
            continue;
        for (const b of m.content) {
            if (b.type === 'tool-call')
                names.set(b.id, b.name);
        }
    }
    return names;
}
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
export function restoreToolCallArgs(messages, callId) {
    if (!callId)
        return undefined;
    for (const m of messages) {
        if (m.role !== 'assistant')
            continue;
        for (const b of m.content) {
            if (b.type !== 'tool-call' || b.id !== callId)
                continue;
            const raw = b.arguments;
            if (typeof raw === 'object' && raw !== null)
                return raw;
            if (typeof raw === 'string' && raw) {
                try {
                    return JSON.parse(raw);
                }
                catch {
                    return raw;
                }
            }
            return raw;
        }
    }
    return undefined;
}
/** Whether this user message carries a non-error `ask_user_question` answer. */
function hasAskUserAnswer(message, toolNames) {
    for (const b of message.content) {
        if (b.type === 'tool-result' && !b.isError && toolNames.get(b.toolCallId) === 'ask_user_question') {
            return true;
        }
    }
    return false;
}
/**
 * The user's answers inside an `ask_user_question` tool result. The tool
 * returns `{answers:[{id, selected:[...], custom?}]}` — an explicit
 * authorization the user gave THROUGH the tool. Parsed for readable intent;
 * if the payload is unparseable, the raw JSON text still counts as a signal.
 */
function askUserAnswersText(message) {
    const parts = [];
    for (const b of message.content) {
        if (b.type !== 'tool-result')
            continue;
        const text = b.content.map(renderBlock).filter(Boolean).join(' ');
        const picked = [];
        try {
            const parsed = JSON.parse(text);
            for (const a of parsed?.answers ?? []) {
                if (Array.isArray(a.selected))
                    for (const s of a.selected)
                        if (typeof s === 'string')
                            picked.push(s);
                if (typeof a.custom === 'string' && a.custom)
                    picked.push(a.custom);
            }
        }
        catch {
            picked.push(text); // unparseable — still an intent signal
        }
        if (picked.length)
            parts.push(picked.join(', '));
    }
    return parts.join(' ');
}
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
export function renderUserIntent(messages, maxMessages) {
    const toolNames = toolNameByCallId(messages);
    const userMsgs = [];
    for (let i = messages.length - 1; i >= 0 && userMsgs.length < maxMessages; i--) {
        const m = messages[i];
        if (!m)
            continue; // noUncheckedIndexedAccess guard
        if (m.role !== 'user')
            continue;
        // Only DIRECT human messages grant permission. Tool results, plugin/system
        // injections, and model messages all carry role "user" but must NOT crowd
        // out the user's actual instructions from the intent window.
        const srcKind = m.source?.kind;
        if (srcKind === undefined || srcKind === 'user') {
            const text = m.content.map(renderBlock).filter(Boolean).join(' ');
            if (text.trim())
                userMsgs.unshift(`${m.role}: ${text}`);
            continue;
        }
        // Tool results: ONLY the user's answers to ask_user_question count as
        // intent (an explicit authorization given through the tool). Ordinary
        // tool output must not crowd the intent window.
        if (srcKind === 'tool' && hasAskUserAnswer(m, toolNames)) {
            const text = askUserAnswersText(m);
            if (text.trim())
                userMsgs.unshift(`user: ${text}`);
        }
    }
    return userMsgs.join('\n\n');
}
/** Truncate a rendered context block to a char budget (classifyContextChars). */
export function truncateToChars(text, maxChars) {
    if (!text || maxChars <= 0)
        return text;
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}
/**
 * Resolve the classifier route: explicit config wins, otherwise the SESSION's
 * current request header (the model the user is actually running), otherwise
 * the agent's configured options. This lets the classifier follow the model the
 * session uses rather than a stale/default one.
 */
export function resolveRoute(agent, configuredProvider, configuredModel) {
    const header = agent.session.requestHeader()?.config;
    const provider = configuredProvider || header?.provider || agent.options?.provider || '';
    const model = configuredModel || header?.model || agent.options?.model || '';
    return { provider, model };
}
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
export function parseVerdict(reply) {
    const trimmed = reply.trim();
    if (trimmed === '')
        return null;
    // Strip markdown code fences (```json … ```).
    let t = trimmed.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
    // Try the first balanced JSON object.
    const firstBrace = t.indexOf('{');
    const lastBrace = t.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = t.slice(firstBrace, lastBrace + 1);
        try {
            const parsed = JSON.parse(candidate);
            const raw = String(parsed.decision ?? parsed.verdict ?? parsed.classification ?? '').toLowerCase();
            // Boolean fields: safe/allow → allow; safe:false/deny/block → reject
            if (parsed.safe === true || parsed.allow === true)
                return verdict('allow', parsed.reason);
            if (parsed.safe === false ||
                parsed.allow === false ||
                parsed.block === true ||
                parsed.deny === true)
                return verdict('reject', parsed.reason);
            if (raw) {
                // CRITICAL: deny-first ordering — "unsafe" contains "safe"
                if (/unsafe|deny|block|reject|forbid/.test(raw))
                    return verdict('reject', parsed.reason);
                if (/safe|allow|permit|approve|yes/.test(raw))
                    return verdict('allow', parsed.reason);
                // Two-state (0.8.0): legacy "ask" output is normalized to reject
                // (fail-closed) — a rejected action can be retried or escalated, a
                // wrongly-allowed one cannot be undone.
                if (raw === 'ask')
                    return verdict('reject', 'uncertain (ask) — treated as reject (fail-closed)');
            }
        }
        catch {
            // not valid JSON — fall through to keyword scan
        }
    }
    // Keyword fallback on the whole text (model-agnostic last resort).
    const low = t.toLowerCase();
    const denySignal = /(^|[^a-z])(unsafe|den(y|ies)|block(ed|ing)?|reject(ed)?|forbid(den)?|malicious|danger(ous)?)([^a-z]|$)/.test(low);
    const allowSignal = /(^|[^a-z])(safe|allow(ed)?|permit(ted)?|approve[ds]?|benign|okay?)([^a-z]|$)/.test(low);
    if (denySignal && !allowSignal)
        return verdict('reject');
    if (allowSignal && !denySignal)
        return verdict('allow');
    if (denySignal && allowSignal)
        return verdict('reject'); // conflict → fail closed
    return null; // no signal → caller fails closed
    function verdict(decision, reason) {
        return {
            decision,
            reason: typeof reason === 'string' && reason.length > 0
                ? reason
                : `classifier decision: ${decision}`,
        };
    }
}
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
export async function fastFilter(ctx, actionSummary, provider, model, signal, timeoutMs, reasoningEffort, logger, onAttemptFail) {
    const res = await streamTokens(ctx, {
        provider,
        model,
        system: 'You are a safety filter. Reply with exactly one digit: 0 if the action is routine and safe, 1 if it needs careful review. Nothing else.',
        user: actionSummary,
        temperature: 0,
        maxTokens: FAST_FILTER_MAX_TOKENS,
        signal,
        timeoutMs,
        reasoningEffort,
        logger,
        stage: 'fast-filter',
        onAttemptFail,
    });
    if (!res)
        return null;
    if (res.reasonKind === 'error' || res.reasonKind === 'aborted')
        return null;
    // Parse a standalone 0/1 digit (reasoning models may emit prose around it).
    const m = res.text.match(/(^|\D)([01])(\D|$)/);
    const d = m?.[2];
    if (d === '0')
        return false; // safe
    if (d === '1')
        return true; // needs review
    logger?.warn(`fastFilter no 0/1 digit (${provider}/${model}); raw=${JSON.stringify(res.text.slice(0, 300))} (length=${res.text.length}, reason=${res.reasonKind})`);
    return null; // malformed → caller decides
}
/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(ctx, options) {
    const res = await streamTokens(ctx, {
        provider: options.provider,
        model: options.model,
        system: options.system,
        user: options.user,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        reasoningEffort: options.reasoningEffort,
        logger: options.logger,
        stage: 'review',
        onAttemptFail: options.onAttemptFail,
    });
    if (!res)
        return null;
    if (res.reasonKind === 'error' || res.reasonKind === 'aborted')
        return null;
    // max-tokens / normal finish → parse whatever text was produced.
    const verdict = parseVerdict(res.text);
    if (!verdict) {
        options.logger?.warn(`classifier no parseable verdict (${options.provider}/${options.model}); raw=${JSON.stringify(res.text.slice(0, 400))}`);
    }
    return verdict;
}
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
export async function classifyTwoStage(ctx, options, actionSummary) {
    options.logger?.info(`classifier route: ${options.provider}/${options.model} (reasoningEffort=${options.reasoningEffort ?? 'default'})`);
    const needsReview = await fastFilter(ctx, actionSummary, options.provider, options.model, options.signal, options.timeoutMs, options.reasoningEffort, options.logger, options.onAttemptFail);
    if (needsReview === false) {
        return { decision: 'allow', reason: 'one-token filter: routine/safe action' };
    }
    // true (needs review) or null (filter failed) → full structured review.
    return classify(ctx, options);
}
