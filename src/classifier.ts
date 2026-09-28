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
import { createUserMessage, type ContentBlock, type Message } from '@deepseek-ai/dsh-llm';
import { AUTO_MODE_SOURCE } from './sources.js';

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
export type ClassifyFailureCategory =
  | 'config:no-route'
  | 'config:unsupported-effort'
  | 'transient:timeout'
  | 'transient:rate-limit'
  | 'transient:overload'
  | 'transient:server'
  | 'transient:connection'
  | 'unknown';

/** Map a classifier-failure detail string to its stable category. */
export function classifyFailureCategory(detail: string): ClassifyFailureCategory {
  const m = detail.toLowerCase();
  if (/no classifier route/.test(m)) return 'config:no-route';
  if (/\bdoes not support reasoning effort\b|unsupported[\s-]*reasoning[\s-]*effort/.test(m)) return 'config:unsupported-effort';
  if (/timed?\s*out|timeout|stalled/.test(m)) return 'transient:timeout';
  if (/rate.?limit|429/.test(m)) return 'transient:rate-limit';
  if (/overload|529/.test(m)) return 'transient:overload';
  if (/server error|\b5\d\d\b/.test(m)) return 'transient:server';
  if (/connect|network|socket|fetch failed|econn/.test(m)) return 'transient:connection';
  return 'unknown';
}

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
  readonly logger?: { info: (m: string) => void; warn: (m: string) => void };
  /**
   * Optional per-attempt failure callback for durable diagnostics (decisions.jsonl).
   * Fired for EVERY failed stream attempt (error finish or thrown exception),
   * including attempts that are retried without effort.
   */
  readonly onAttemptFail?: (info: ClassifyAttemptFailInfo) => void;
}

/**
 * Combine a request cancellation signal with a hard timeout.
 * Uses AbortSignal.any/timeout (Node >= 20.3). Falls back to just the
 * request signal when no timeout is configured.
 */
function effectiveSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
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

/** A single classifier stream invocation spec (provider/model/system/user + controls). */
interface StreamSpec {
  provider: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  reasoningEffort?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
  /** Which classifier stage owns this call (for durable diagnostics). */
  stage?: 'fast-filter' | 'review';
  /** Per-attempt failure callback (see ClassifyOptions.onAttemptFail). */
  onAttemptFail?: (info: ClassifyAttemptFailInfo) => void;
}

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
async function streamTokens(
  ctx: Context,
  spec: StreamSpec,
): Promise<{ text: string; reasonKind: string | null; failure: ClassifyFailure | null } | null> {
  const attempts: Array<string | undefined> = spec.reasoningEffort
    ? [spec.reasoningEffort, undefined]
    : [undefined];
  for (const effort of attempts) {
    let text = '';
    let reasonKind: string | null = null;
    let failure: ClassifyFailure | null = null;
    try {
      for await (const chunk of ctx.llm.stream({
        provider: spec.provider,
        model: spec.model,
        system: spec.system,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: spec.user }],
            source: AUTO_MODE_SOURCE,
          }),
        ],
        temperature: spec.temperature,
        maxTokens: spec.maxTokens,
        signal: effectiveSignal(spec.signal, spec.timeoutMs),
        ...(effort !== undefined ? { reasoningEffort: effort as any } : {}),
      })) {
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'finish') {
          reasonKind = chunk.reason?.kind ?? null;
          const f = (chunk.reason as { failure?: { message?: string; code?: string } } | undefined)?.failure;
          if (f?.message) failure = { message: f.message, code: f.code ?? null };
        }
      }
      if (reasonKind === 'error') {
        // Terminal error finish — dispatch/validation failure, not a throw.
        if (failure) {
          spec.logger?.warn(
            `classifier stream failed (${spec.provider}/${spec.model})${effort ? ` effort=${effort}` : ''}: ${failure.message}${failure.code ? ` [${failure.code}]` : ''}`,
          );
          spec.onAttemptFail?.({
            stage: spec.stage ?? 'review',
            effort: effort ?? null,
            failure,
            raw: text,
          });
        }
        if (effort !== undefined) continue; // retry without effort
      }
      return { text, reasonKind, failure };
    } catch (error) {
      if (
        (error as { code?: string } | null)?.code === 'UNSUPPORTED_REASONING_EFFORT' &&
        effort !== undefined
      ) {
        continue; // route doesn't support the effort → retry without it
      }
      const code = (error as { code?: string } | null)?.code;
      const message = String((error as { message?: string } | null)?.message ?? error);
      spec.logger?.warn(
        `classifier stream failed (${spec.provider}/${spec.model})${effort ? ` effort=${effort}` : ''}: ${message}${code ? ` [${code}]` : ''}`,
      );
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
function renderBlock(block: ContentBlock): string {
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
function renderMessage(message: Message): string {
  const content = message.content.map(renderBlock).filter(Boolean).join(' ');
  return `${message.role}: ${content}`;
}

/**
 * Render a transcript as classifier input: the trailing `maxMessages`
 * messages, oldest first, one per line.
 */
export function renderTranscript(
  messages: readonly Message[],
  maxMessages: number,
): string {
  const tail = messages.slice(Math.max(0, messages.length - maxMessages));
  return tail.map(renderMessage).join('\n\n');
}

/** toolCallId → tool name across the window, to recognize ask_user_question results. */
function toolNameByCallId(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool-call') names.set(b.id, b.name);
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
export function restoreToolCallArgs(
  messages: readonly Message[],
  callId: string | undefined,
): unknown {
  if (!callId) return undefined;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type !== 'tool-call' || b.id !== callId) continue;
      const raw = b.arguments;
      if (typeof raw === 'object' && raw !== null) return raw;
      if (typeof raw === 'string' && raw) {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      }
      return raw;
    }
  }
  return undefined;
}

/**
 * The callId a tool result answers, read from EITHER host envelope (v0.16.1).
 *
 *  - v3 (`dsh <= 0.1.6`): `role: 'user'` + `source.kind: 'tool'`, and the
 *    `tool-result` content block carries `toolCallId` (`toolCallId === source.callId`
 *    is enforced by the host's own validator);
 *  - v4 (`dsh >= 0.1.7-rc.2`, session format v4): a first-class `role: 'tool'`
 *    message whose content is plain text blocks; the callId sits in
 *    `source.callId` **and** in a top-level `toolCallId` (no `tool-result` block).
 *
 * `source.callId` exists in both, so it is read first; the top-level field and the
 * nested block are the per-generation fallbacks, and a host that ever carries
 * more than one of them writes the same value (the v3 -> v4 converter enforces
 * that), so the order cannot disagree on a real log.
 */
function toolResultCallId(message: Message): string | undefined {
  const src = message.source as { callId?: unknown } | undefined;
  if (typeof src?.callId === 'string' && src.callId) return src.callId;
  const top = (message as { toolCallId?: unknown }).toolCallId;
  if (typeof top === 'string' && top) return top;
  for (const b of message.content) {
    if (b.type === 'tool-result' && b.toolCallId) return b.toolCallId;
  }
  return undefined;
}

/**
 * Whether this message is a TOOL-RESULT CARRIER, in either envelope:
 * `role: 'tool'` (v4 first-class message) or tool provenance
 * `source.kind === 'tool'` (both generations). This only decides which branch to
 * *consider*; the authority check is the callId -> `ask_user_question` mapping
 * below.
 *
 * Provenance is REQUIRED, deliberately: a `tool-result` block on a message whose
 * source says something else (`plugin:…`) must not be able to stand in for a
 * tool result — that is the same stance Channel 1 takes for human messages
 * (v0.15.1: a source that is present but not `user` is untrustworthy). No real
 * host produces such a shape anyway: the v4 log format refuses `tool-result`
 * wrappers outright, and its v3 -> v4 converter only lifts wrappers that carry
 * `source.kind: 'tool'`.
 */
function isToolResultCarrier(message: Message, srcKind: string | undefined): boolean {
  return (message.role as string) === 'tool' || srcKind === 'tool';
}

/**
 * Whether this message carries a NON-ERROR `ask_user_question` answer, in
 * either envelope (v0.16.1).
 *
 * The authority rule is unchanged and deliberately narrow: the result's callId
 * must map back to the `ask_user_question` tool call it answers. Ordinary tool
 * output, plugin injections and model messages still authorize nothing
 * (v0.15.1) — widening past the tool-name check would turn tool output into an
 * escalation channel.
 */
function hasAskUserAnswer(message: Message, toolNames: Map<string, string>): boolean {
  // Legacy (v3) envelope: the block is authoritative — it carries both the
  // callId and its own error flag.
  const results = message.content.filter((b) => b.type === 'tool-result');
  if (results.length > 0) {
    return results.some((b) => !b.isError && toolNames.get(b.toolCallId) === 'ask_user_question');
  }
  // v4 envelope: no `tool-result` block exists; the callId sits on the message
  // (`source.callId` / top-level `toolCallId`) and so does the error flag.
  if ((message as { isError?: unknown }).isError === true) return false;
  const callId = toolResultCallId(message);
  return callId !== undefined && toolNames.get(callId) === 'ask_user_question';
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
function askedQuestionsByCallId(messages: readonly Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type !== 'tool-call' || b.name !== 'ask_user_question') continue;
      let args: unknown = b.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args) as unknown;
        } catch {
          continue;
        }
      }
      const questions = (args as { questions?: Array<{ question?: unknown }> } | null)?.questions;
      if (!Array.isArray(questions)) continue;
      const text = questions
        .map((q) => (typeof q?.question === 'string' ? q.question.trim() : ''))
        .filter(Boolean)
        .join(' / ');
      if (text) out.set(b.id, text);
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
function askUserAnswersText(message: Message, questionByCallId: Map<string, string>): string {
  const parts: string[] = [];
  for (const b of message.content) {
    // v3: the answer is nested inside the `tool-result` block's own content;
    // v4: it is the text of a plain block (a JSON string).
    const text = b.type === 'tool-result'
      ? b.content.map(renderBlock).filter(Boolean).join(' ')
      : b.type === 'text'
        ? b.text
        : '';
    if (!text) continue;
    const picked: string[] = [];
    try {
      const parsed = JSON.parse(text) as { answers?: Array<{ selected?: unknown; custom?: unknown }> };
      for (const a of parsed?.answers ?? []) {
        if (Array.isArray(a.selected)) for (const s of a.selected) if (typeof s === 'string') picked.push(s);
        if (typeof a.custom === 'string' && a.custom) picked.push(a.custom);
      }
    } catch {
      picked.push(text); // unparseable — still an intent signal
    }
    if (picked.length) parts.push(picked.join(', '));
  }
  if (parts.length === 0) return '';
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
 * Since v0.16.1 that answer is read in BOTH host envelopes — the legacy
 * `tool-result` block (v3) and the first-class `role: 'tool'` message whose
 * content is plain text (v4, `dsh >= 0.1.7-rc.2`).
 */
export function renderUserIntent(
  messages: readonly Message[],
  maxMessages: number,
): string {
  const toolNames = toolNameByCallId(messages);
  const askedQuestions = askedQuestionsByCallId(messages);
  const userMsgs: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMsgs.length < maxMessages; i--) {
    const m = messages[i];
    if (!m) continue; // noUncheckedIndexedAccess guard
    // Defensive: the v4 role union grew ('tool', 'developer') and this function
    // reads every host message; a shape without a content array must not crash
    // the gate (a throw here would surface as a plugin error on every call).
    if (!Array.isArray(m.content)) continue;
    // `role` is widened on purpose: this repo's devDependency dsh-llm
    // (0.1.0-rc.8) still types the union as 'system' | 'user' | 'assistant',
    // while the v4 host adds 'tool' (and 'developer'). Compare the LIVE value
    // instead of assuming a host generation (same stance as the permission
    // probe), so the same build works on both.
    const role = m.role as string;
    const src = m.source as { kind?: string } | undefined;
    const srcKind = src?.kind;
    // Channel 1 — DIRECT human messages. Tool results, plugin/system
    // injections, and model messages all carry role "user" on old hosts but must
    // NOT crowd out the user's actual instructions from the intent window.
    //
    // `source` MISSING entirely ⇒ an older host that never tagged provenance;
    // that is the compatibility fallback (dropping it would make real user
    // messages stop authorizing anything on such a host). A `source` object that
    // is PRESENT but carries no `kind` is a different, untrustworthy case and is
    // NOT admitted: measured on this host, every non-human injection
    // (`tool`, `plugin`, `agent-instructions`, `agent-message`,
    // `subagent-settled`) does carry a kind, so nothing legitimate is lost
    // (v0.15.1, review m7 hardening).
    if (role === 'user' && (srcKind === 'user' || src === undefined)) {
      const text = m.content.map(renderBlock).filter(Boolean).join(' ');
      if (text.trim()) userMsgs.unshift(`${m.role}: ${text}`);
      continue;
    }
    // Channel 2 — tool-based authorization. ONLY the user's answers to
    // ask_user_question count as intent (an explicit authorization given through
    // the tool); ordinary tool output must not crowd the intent window.
    //
    // Envelope-agnostic since v0.16.1: the carrier may be a `role: 'tool'`
    // message with text content (v4) or the legacy `role: 'user'` message with a
    // `tool-result` block (v3). Reading only the legacy envelope silently lost
    // every tool-based grant on v4 hosts — the answer never reached the window,
    // the intent hash never changed, and a cached DENY (or a classifier that
    // only saw the earlier question) kept rejecting an action the user had just
    // confirmed.
    if (isToolResultCarrier(m, srcKind) && hasAskUserAnswer(m, toolNames)) {
      const text = askUserAnswersText(m, askedQuestions);
      if (text.trim()) userMsgs.unshift(`user: ${text}`);
    }
  }
  return userMsgs.join('\n\n');
}

/** Truncate a rendered context block to a char budget (classifyContextChars). */
export function truncateToChars(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return text;
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}

/**
 * Resolve the classifier route: explicit config wins, otherwise the SESSION's
 * current request header (the model the user is actually running), otherwise
 * the agent's configured options. This lets the classifier follow the model the
 * session uses rather than a stale/default one.
 */
export function resolveRoute(
  agent: Agent,
  configuredProvider: string,
  configuredModel: string,
): { provider: string; model: string } {
  const header = agent.session.requestHeader()?.config;
  const provider =
    configuredProvider || header?.provider || agent.options?.provider || '';
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
export function parseVerdict(reply: string): Verdict | null {
  const trimmed = reply.trim();
  if (trimmed === '') return null;

  // Strip markdown code fences (```json … ```).
  let t = trimmed.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');

  // Try the first balanced JSON object.
  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = t.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const raw = String(
        parsed.decision ?? parsed.verdict ?? parsed.classification ?? '',
      ).toLowerCase();

      // Boolean fields: safe/allow → allow; safe:false/deny/block → reject
      if (parsed.safe === true || parsed.allow === true)
        return verdict('allow', parsed.reason);
      if (
        parsed.safe === false ||
        parsed.allow === false ||
        parsed.block === true ||
        parsed.deny === true
      )
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
    } catch {
      // not valid JSON — fall through to keyword scan
    }
  }

  // Keyword fallback on the whole text (model-agnostic last resort).
  const low = t.toLowerCase();
  const denySignal =
    /(^|[^a-z])(unsafe|den(y|ies)|block(ed|ing)?|reject(ed)?|forbid(den)?|malicious|danger(ous)?)([^a-z]|$)/.test(
      low,
    );
  const allowSignal =
    /(^|[^a-z])(safe|allow(ed)?|permit(ted)?|approve[ds]?|benign|okay?)([^a-z]|$)/.test(
      low,
    );

  if (denySignal && !allowSignal) return verdict('reject');
  if (allowSignal && !denySignal) return verdict('allow');
  if (denySignal && allowSignal) return verdict('reject'); // conflict → fail closed

  return null; // no signal → caller fails closed

  function verdict(
    decision: VerdictDecision,
    reason?: unknown,
  ): Verdict {
    return {
      decision,
      reason:
        typeof reason === 'string' && reason.length > 0
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
export async function fastFilter(
  ctx: Context,
  actionSummary: string,
  provider: string,
  model: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  reasoningEffort?: string,
  logger?: { info: (m: string) => void; warn: (m: string) => void },
  onAttemptFail?: (info: ClassifyAttemptFailInfo) => void,
): Promise<boolean | null> {
  const res = await streamTokens(ctx, {
    provider,
    model,
    system:
      'You are a safety filter. Reply with exactly one digit: 0 if the action is routine and safe, 1 if it needs careful review. Nothing else.',
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
  if (!res) return null;
  if (res.reasonKind === 'error' || res.reasonKind === 'aborted') return null;
  const d = parseFastFilterDigit(res.text);
  if (d === '0') return false; // safe
  if (d === '1') return true; // needs review
  logger?.warn(
    `fastFilter no unambiguous 0/1 digit (${provider}/${model}); raw=${JSON.stringify(res.text.slice(0, 300))} (length=${res.text.length}, reason=${res.reasonKind})`,
  );
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
export function parseFastFilterDigit(reply: string): '0' | '1' | null {
  const t = reply.trim().replace(/^[*`\s]+|[*`\s]+$/g, '');
  if (t === '0' || t === '1') return t;
  if (t.length <= 24) {
    const lead = t.match(/^([01])(?!\d)/);
    if (lead && !/(^|\D)[01](\D|$)/.test(t.slice(1))) return lead[1] as '0' | '1';
  }
  return null;
}

/**
 * Run one classifier call. Returns the verdict, or `null` when the call
 * failed, was aborted, was truncated, or produced an unparsable reply.
 */
export async function classify(
  ctx: Context,
  options: ClassifyOptions,
): Promise<Verdict | null> {
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
  if (!res) return null;
  if (res.reasonKind === 'error' || res.reasonKind === 'aborted') return null;
  // max-tokens / normal finish → parse whatever text was produced.
  const verdict = parseVerdict(res.text);
  if (!verdict) {
    options.logger?.warn(
      `classifier no parseable verdict (${options.provider}/${options.model}); raw=${JSON.stringify(res.text.slice(0, 400))}`,
    );
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
export function argsPreviewOf(args: unknown): string | undefined {
  if (args === null || args === undefined) return undefined;
  let text: string;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  // Never leave a lone high surrogate behind (a cut inside an emoji pair).
  const cut = truncateToChars(text, ARGS_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '');
  return cut.replace(/\s+/g, ' ');
}

/** Whether a preview was cut short — a truncated payload hides its own tail, so
 * callers force the structured review rather than let the filter decide it. */
export function previewTruncated(preview: string | undefined): boolean {
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
export function actionSummaryOf(
  toolName: string,
  reason: string | undefined,
  command?: string,
  paths?: readonly string[],
  argsPreview?: string,
): string {
  const action = command?.trim() || (paths && paths.length > 0 ? paths.join(', ') : '');
  const lines = [action ? `${toolName}: ${action}` : toolName];
  // Prose-bearing tools (no command, no paths) would otherwise hand the filter
  // narration ONLY — the defect v0.15.1 set out to fix, still live for every
  // non-bash/non-file tool (v0.15.1, review M2).
  if (!action && argsPreview?.trim()) lines.push(`arguments: ${argsPreview.trim()}`);
  if (reason?.trim()) lines.push(`justification: ${reason.trim()}`);
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
export async function classifyTwoStage(
  ctx: Context,
  options: ClassifyOptions,
  actionSummary: string,
  forceReview = false,
): Promise<Verdict | null> {
  options.logger?.info(
    `classifier route: ${options.provider}/${options.model} (reasoningEffort=${options.reasoningEffort ?? 'default'})`,
  );
  const needsReview = await fastFilter(
    ctx,
    actionSummary,
    options.provider,
    options.model,
    options.signal,
    options.timeoutMs,
    options.reasoningEffort,
    options.logger,
    options.onAttemptFail,
  );
  if (needsReview === false && !forceReview) {
    return { decision: 'allow', reason: 'one-token filter: routine/safe action' };
  }
  if (needsReview === false && forceReview) {
    // The filter said "routine/safe", but the action can affect other people or
    // systems: this decision belongs to the structured review, which is the only
    // stage that reads the user's authorization (v0.15.1).
    options.logger?.info(
      'one-token filter said safe, but the action can leave this machine — running the structured review anyway',
    );
  }
  // true (needs review), null (filter failed/ambiguous), or forced → full review.
  return classify(ctx, options);
}
