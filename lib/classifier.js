import { createUserMessage } from '@deepseek-ai/dsh-llm';
/** Map a classifier-failure detail string to its stable category. */
export function classifyFailureCategory(detail) {
    const m = detail.toLowerCase();
    if (/no classifier route/.test(m))
        return 'config:no-route';
    if (/\bdoes not support reasoning effort\b|unsupported[\s-]*reasoning[\s-]*effort/.test(m))
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
 * The questions the agent asked, keyed by the `ask_user_question` tool call id.
 *
 * Carried into the intent window so a terse answer ("yes") can be matched to the
 * action it was about (v0.15.1). The question text is AGENT-authored and is
 * labelled as such in the prompt: it disambiguates WHAT the user answered, it
 * does not itself authorize anything, and it cannot widen their answer beyond
 * its plain meaning.
 */
function askedQuestionsByCallId(messages) {
    const out = new Map();
    for (const m of messages) {
        if (m.role !== 'assistant')
            continue;
        for (const b of m.content) {
            if (b.type !== 'tool-call' || b.name !== 'ask_user_question')
                continue;
            let args = b.arguments;
            if (typeof args === 'string') {
                try {
                    args = JSON.parse(args);
                }
                catch {
                    continue;
                }
            }
            const questions = args?.questions;
            if (!Array.isArray(questions))
                continue;
            const text = questions
                .map((q) => (typeof q?.question === 'string' ? q.question.trim() : ''))
                .filter(Boolean)
                .join(' / ');
            if (text)
                out.set(b.id, text);
        }
    }
    return out;
}
/**
 * The user's answers inside an `ask_user_question` tool result. The tool
 * returns `{answers:[{id, selected:[...], custom?}]}` — an explicit
 * authorization the user gave THROUGH the tool. Parsed for readable intent;
 * if the payload is unparseable, the raw JSON text still counts as a signal.
 */
function askUserAnswersText(message, questionByCallId) {
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
    if (parts.length === 0)
        return '';
    const answer = parts.join(' ');
    const questions = [...questionByCallId.values()];
    const asked = questions.length > 0 ? [...new Set(questions)].join(' / ') : '';
    // The question is quoted and attributed so the classifier can tell the user's
    // words from the agent's: it says what the answer is ABOUT, nothing more.
    return asked
        ? `${answer} [answering the agent's question: ${JSON.stringify(asked)}]`
        : answer;
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
    const askedQuestions = askedQuestionsByCallId(messages);
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
        //
        // `source` MISSING entirely ⇒ an older host that never tagged provenance;
        // that is the compatibility fallback (dropping it would make real user
        // messages stop authorizing anything on such a host). A `source` object that
        // is PRESENT but carries no `kind` is a different, untrustworthy case and is
        // NOT admitted: measured on this host, every non-human injection
        // (`tool`, `plugin`, `agent-instructions`, `agent-message`,
        // `subagent-settled`) does carry a kind, so nothing legitimate is lost
        // (v0.15.1, review m7 hardening).
        const src = m.source;
        const srcKind = src?.kind;
        if (srcKind === 'user' || (src === undefined && srcKind === undefined)) {
            const text = m.content.map(renderBlock).filter(Boolean).join(' ');
            if (text.trim())
                userMsgs.unshift(`${m.role}: ${text}`);
            continue;
        }
        // Tool results: ONLY the user's answers to ask_user_question count as
        // intent (an explicit authorization given through the tool). Ordinary
        // tool output must not crowd the intent window.
        if (srcKind === 'tool' && hasAskUserAnswer(m, toolNames)) {
            const text = askUserAnswersText(m, askedQuestions);
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
    const d = parseFastFilterDigit(res.text);
    if (d === '0')
        return false; // safe
    if (d === '1')
        return true; // needs review
    logger?.warn(`fastFilter no unambiguous 0/1 digit (${provider}/${model}); raw=${JSON.stringify(res.text.slice(0, 300))} (length=${res.text.length}, reason=${res.reasonKind})`);
    return null; // malformed/ambiguous → caller runs the full review (fail-closed)
}
/**
 * Parse the fast filter's one-digit reply.
 *
 * Exact `0`/`1` wins. A SHORT reply led by the digit ("0 (safe)") is tolerated.
 * Everything else fails closed: the filter's input now carries the COMMAND TEXT
 * (v0.15.1), so a chatty reply echoes the command (`v0.15.0`, `exit 0`) — an
 * echoed digit must never be read as a verdict, and an echo with only zeros
 * used to be accepted as "safe" (review M3).
 */
export function parseFastFilterDigit(reply) {
    const t = reply.trim().replace(/^[*`\s]+|[*`\s]+$/g, '');
    if (t === '0' || t === '1')
        return t;
    if (t.length <= 24) {
        const lead = t.match(/^([01])(?!\d)/);
        if (lead && !/(^|\D)[01](\D|$)/.test(t.slice(1)))
            return lead[1];
    }
    return null;
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
/** Character budget for the prose-bearing args preview (v0.15.1). */
export const ARGS_PREVIEW_CHARS = 600;
/**
 * A single, truncated preview of a tool call's arguments, for tools that carry
 * NEITHER a command nor target paths (v0.15.1, review M2).
 *
 * Such a call — a dispatched subagent, a workflow script, any text-carrying tool
 * — used to reach both classifier stages with the agent's justification and
 * nothing else: the narration-only defect v0.15.1 fixed for bash and file tools
 * was still live for every other tool, while the prose-scope change had just
 * removed the deny band's only view of those payloads.
 */
export function argsPreviewOf(args) {
    if (args === null || args === undefined)
        return undefined;
    let text;
    try {
        text = typeof args === 'string' ? args : JSON.stringify(args);
    }
    catch {
        return undefined;
    }
    if (!text)
        return undefined;
    // Never leave a lone high surrogate behind (a cut inside an emoji pair).
    const cut = truncateToChars(text, ARGS_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '');
    return cut.replace(/\s+/g, ' ');
}
/** Whether a preview was cut short — a truncated payload hides its own tail, so
 * callers force the structured review rather than let the filter decide it. */
export function previewTruncated(preview) {
    return preview !== undefined && preview.includes('(truncated)');
}
/**
 * Build the one-token fast filter's input (v0.15.1).
 *
 * The filter must judge the ACTION, so the summary leads with the command text
 * or the target paths and only carries the agent's justification as an
 * annotation. Before v0.15.1 both call sites passed `${toolName} (${reason})`
 * — narration only — and a "0" from the filter returns ALLOW without ever
 * running the full review: the prompt contract was bypassed on the one path
 * where narration was the sole input, in the allow direction. Measured: the
 * same `git tag … && git push` was allowed 5/5 with a confident justification
 * and rejected 5/5 with a hedged one.
 */
export function actionSummaryOf(toolName, reason, command, paths, argsPreview) {
    const action = command?.trim() || (paths && paths.length > 0 ? paths.join(', ') : '');
    const lines = [action ? `${toolName}: ${action}` : toolName];
    // Prose-bearing tools (no command, no paths) would otherwise hand the filter
    // narration ONLY — the defect v0.15.1 set out to fix, still live for every
    // non-bash/non-file tool (v0.15.1, review M2).
    if (!action && argsPreview?.trim())
        lines.push(`arguments: ${argsPreview.trim()}`);
    if (reason?.trim())
        lines.push(`justification: ${reason.trim()}`);
    return lines.join('\n');
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
export async function classifyTwoStage(ctx, options, actionSummary, forceReview = false) {
    options.logger?.info(`classifier route: ${options.provider}/${options.model} (reasoningEffort=${options.reasoningEffort ?? 'default'})`);
    const needsReview = await fastFilter(ctx, actionSummary, options.provider, options.model, options.signal, options.timeoutMs, options.reasoningEffort, options.logger, options.onAttemptFail);
    if (needsReview === false && !forceReview) {
        return { decision: 'allow', reason: 'one-token filter: routine/safe action' };
    }
    if (needsReview === false && forceReview) {
        // The filter said "routine/safe", but the action can affect other people or
        // systems: this decision belongs to the structured review, which is the only
        // stage that reads the user's authorization (v0.15.1).
        options.logger?.info('one-token filter said safe, but the action can leave this machine — running the structured review anyway');
    }
    // true (needs review), null (filter failed/ambiguous), or forced → full review.
    return classify(ctx, options);
}
