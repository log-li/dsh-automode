import '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
// v0.14.3 (issue #1): the permission SETTERS are probed at runtime, never
// named-imported — newer hosts (Desktop 2.0.5 series) removed these exports and
// a named import would crash plugin load at module-instantiation.
import * as userApprovalModule from '@deepseek-ai/dsh-user-approval';
import * as sandboxPolicyModule from '@deepseek-ai/dsh-sandbox-policy';
import { Config, expandDefaults } from './config.js';
import { permissionSnapshot } from './permission-state.js';
import { classifyBand, compileRegex, bashCommandOf, isFileTool, collectPaths } from './bands.js';
import { findAllowRule, findDenyRule, isAllowlisted } from './rules.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import { actionSummaryOf, classifyFailureCategory, classifyTwoStage, renderTranscript, renderUserIntent, resolveRoute, restoreToolCallArgs, truncateToChars, } from './classifier.js';
import { VerdictCache, hashString } from './cache.js';
import { Breaker } from './breaker.js';
import { AllowPathBridge } from './bridge.js';
import { registerPreExecute, BREAKER_TRIPPED_HINT } from './pre-execute.js';
import { appendDecision } from './log.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-automode';
export { Config };
export const inject = ['approval', 'llm', 'sessionProjections'];
/** Plugin version read from the package manifest at runtime (never hardcoded). */
const PKG_VERSION = (() => {
    try {
        const p = fileURLToPath(new URL('../package.json', import.meta.url));
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        return typeof raw.version === 'string' ? raw.version : 'unknown';
    }
    catch {
        return 'unknown';
    }
})();
const AUTO_MODE_PRESET = 'auto-mode';
const AUTO_SANDBOX = 'workspace-write';
// ---- System-prompt shadowing (Nuo-cl) ----
const AUTO_SENTENCE = 'Approval policy: auto. A separate reviewer model decides each permission-gated ' +
    'tool call: allow or reject. A reject is denied before execution — retry safely or ' +
    'escalate to the user (a wrong allow cannot be undone). If a tool result says the ' +
    'user rejected the call, the reviewer may have blocked it — not necessarily a person.';
const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through ' +
    'the configured answerers; without an available answerer, the request fails closed.';
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require ' +
    'approval are rejected automatically — do not request sandbox escalation.';
const ALLOWLIST_SENTENCE = 'Auto-mode path allowlist: to trust a path the classifier rejects, add it to ' +
    '`config.allowPaths` on the `- id: auto-mode` row of `<profile>/cordis.patch.yml` ' +
    '(e.g. ~/.dsh/profiles/web/cordis.patch.yml). Keep the default `/tmp/` — the patch ' +
    'replaces the whole config. Allowlisted paths skip the classifier for file tools and ' +
    'bash write-commands; deny patterns still run first. Note: the allowlist only skips ' +
    "this plugin's review — DSH's file sandbox still applies, so a write to an " +
    'allowlisted path OUTSIDE the workspace needs `sandbox_permissions: danger-full-access`; ' +
    'for allowlisted paths that escalation is auto-approved with no review. Only edit after ' +
    'the user explicitly asks; otherwise propose the change and wait.';
// ---- Helpers ----
export function isAuto(ctx, session) {
    return permissionSnapshot(ctx, session).preset === AUTO_MODE_PRESET;
}
function policyOf(ctx, session) {
    return isAuto(ctx, session) ? 'auto' : permissionSnapshot(ctx, session).approval ?? undefined;
}
/** v0.14.3: probe a (possibly removed) void setter off a namespace module. */
export function probeSetter(module, name) {
    if (module === null || typeof module !== 'object')
        return undefined;
    const value = module[name];
    return typeof value === 'function' ? value : undefined;
}
/** Setters resolved at load time; undefined when the host removed the export. */
const setApprovalPolicy = probeSetter(userApprovalModule, 'setApprovalPolicy');
const setSandboxMode = probeSetter(sandboxPolicyModule, 'setSandboxMode');
const missingSettersWarned = new Set();
function writeAutoModeKnobs(ctx, session) {
    const state = permissionSnapshot(ctx, session);
    if (state.preset !== AUTO_MODE_PRESET) {
        session.append('permission/preset', { preset: AUTO_MODE_PRESET });
    }
    if (state.sandbox !== AUTO_SANDBOX) {
        if (setSandboxMode)
            setSandboxMode(session, AUTO_SANDBOX);
        else
            warnSetterMissing(ctx, 'setSandboxMode');
    }
    const current = state.approval ?? ctx.approval.config.policy ?? 'ask';
    if (current !== 'ask') {
        if (setApprovalPolicy)
            setApprovalPolicy(session, 'ask');
        else
            warnSetterMissing(ctx, 'setApprovalPolicy');
    }
}
/** Degrade, never crash, when the host removed a permission setter (issue #1). */
function warnSetterMissing(ctx, name) {
    if (missingSettersWarned.has(name))
        return;
    missingSettersWarned.add(name);
    ctx.logger('auto-mode').warn(`dsh-automode: host removed the "${name}" export — that auto-mode knob will not be set (degraded mode). ` +
        'Consider a host that still exports the permission setters.');
}
export function writeAutoMode(ctx, agent) {
    if (isAuto(ctx, agent.session))
        return;
    const service = ctx.get('permissionPresets');
    if (service) {
        try {
            service.set(agent.session, AUTO_MODE_PRESET);
        }
        catch {
            writeAutoModeKnobs(ctx, agent.session);
        }
    }
    else {
        writeAutoModeKnobs(ctx, agent.session);
    }
    agent.inject(createUserMessage({
        content: [{ type: 'text', text: 'Auto mode enabled. Permission-gated tool calls will now be decided automatically.' }],
        source: { kind: 'plugin', plugin: 'auto-mode' },
    }));
}
// ---- Main decision chain ----
function denialText(category, reason) {
    return `dsh-automode denied this action (${category}): ${reason}. ` +
        'Try a safer alternative. If there is NO safer alternative, STOP retrying and ask the user for explicit permission ' +
        '(a denied action will keep failing; only explicit user approval lets a later attempt pass).';
}
function classifierUnavailableText(detail, toolName) {
    switch (classifyFailureCategory(detail)) {
        case 'config:no-route':
            return `dsh-automode: no classifier route is configured, so auto mode cannot determine the safety of ${toolName} right now. Set classifier.provider/model (or switch to a supported route) to restore automatic decisions. (detail: ${detail})`;
        case 'config:unsupported-effort':
            return `dsh-automode: the safety classifier route rejects the configured reasoning effort (UNSUPPORTED_REASONING_EFFORT), so auto mode cannot determine the safety of ${toolName}. Check classifier.provider/model (or the model's metadata) or switch to a route that supports the configured effort — retrying will not help. (detail: ${detail})`;
        default: {
            const cat = classifyFailureCategory(detail);
            const m = cat.replace(/^transient:/, '');
            return `dsh-automode: the safety classifier is temporarily unavailable${cat === 'unknown' ? '' : ` (${m})`}, so auto mode cannot determine the safety of ${toolName} right now. Wait a moment and then try this action again. (detail: ${detail})`;
        }
    }
}
async function decideAuto(ctx, config, req, next, cache, breaker, bridge, logger) {
    const { agent, toolName, reason, signal } = req;
    if (signal?.aborted)
        return 'cancelled';
    // v0.13.0 (cache-signature parity): recover the raw arguments of THIS tool
    // call by its callId from the session. The approval payload omits args
    // (`ApprovalRequest` links to the already-presented call instead), but the
    // pre-execute gate signed the verdict cache with the real command text —
    // without recovering it here the approval path sign with the escalation
    // reason, keys never match, the cache always misses, and a second classifier
    // run with LESS information overrides the gate's verdict. Same-call arguments
    // make both signatures identical; fall back to `undefined` (legacy behavior)
    // when the call is outside the session window.
    const derived = agent.session.deriveMessages();
    const args = restoreToolCallArgs(derived, req.callId);
    // 1. Hard deny rules (deterministic regex bands)
    const denyPatterns = config.deny.map(compileRegex);
    const denyHit = classifyBand(toolName, reason ?? '', args, denyPatterns, [], []);
    if (denyHit.action === 'deny') {
        logger.info(`deny band "${denyHit.tier}" matched → reject ${toolName}`);
        return 'rejected';
    }
    // 2. Prose deny rules (soft_deny, $defaults expanded)
    const softDenyRules = expandDefaults(config.rules.deny, 'soft_deny');
    const denyRule = findDenyRule(softDenyRules, toolName, reason);
    if (denyRule) {
        logger.info(`soft deny rule "${denyRule}" → reject ${toolName}`);
        return 'rejected';
    }
    // 2.5. AllowPath bridge (2026-08-31): the pre-execute gate already proved every
    // target of THIS exact call (matched by callId) is inside config.allowPaths,
    // and deny patterns ran first above — grant the escalation deterministically
    // without classifier review. Non-bridged calls (non-allowlisted, stale, or a
    // different tool) fall through unchanged. Mirrors the gate's order: deny
    // first, allowPath second.
    const bridged = req.callId !== undefined && req.callId !== null
        ? bridge.take(String(req.callId), toolName)
        : undefined;
    if (bridged) {
        logger.info(`allowPath bridge hit for ${toolName} (${String(req.callId)}) → approve`);
        appendDecision({
            event: 'approval-bridge',
            tool: toolName,
            sessionId: String(agent.session.id ?? '?'),
            detail: `curated allowPath escalation auto-allowed: ${bridged.paths.join(', ')}`,
        });
        return 'allowed-once';
    }
    // 3. Prose allow rules (soft_allow, $defaults expanded)
    const softAllowRules = expandDefaults(config.rules.allow, 'soft_allow');
    const allowRule = findAllowRule(softAllowRules, toolName, reason);
    if (allowRule) {
        logger.info(`soft allow rule "${allowRule}" → approve ${toolName}`);
        return 'allowed-once';
    }
    // 4. Pre-approved tools (read-only fast path)
    if (isAllowlisted(toolName, config.readOnlyTools)) {
        logger.info(`readOnlyTools fast path → approve ${toolName}`);
        return 'allowed-once';
    }
    // The user's recent DIRECT instructions are part of the verdict key (the
    // classifier weighs them), so a new explicit authorization must invalidate
    // any cached DENY for this action. (`derived` was taken once, at the top, so
    // the intent hash here matches the pre-execute gate's — the gate only keeps
    // user messages, and no user message is inserted between gate and approval.)
    const userIntent = renderUserIntent(derived, config.classifier.maxIntentMessages);
    const intentHash = hashString(userIntent);
    // 5. Cache hit (pre-execute already classified)
    const sig = VerdictCache.sig(toolName, reason ?? '', args, config.maxArgsChars, intentHash);
    const sid = String(agent.session.id ?? '?');
    const cached = cache.get(sid, sig);
    if (cached === 'ALLOW') {
        logger.info(`cache hit ALLOW → approve ${toolName}`);
        return 'allowed-once';
    }
    if (cached === 'DENY') {
        logger.info(`cache hit DENY → reject ${toolName}`);
        // Cached classifier denies count toward the breaker too (see spec 2026-08-25):
        // repeated identical escalation attempts must be able to trip it so the
        // breaker-gated human-approval path for sandbox escalation becomes reachable.
        const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
        if (justTripped) {
            logger.warn(`breaker tripped for session ${sid}`);
            const b = breaker.get(sid);
            appendDecision({
                event: 'breaker',
                action: 'tripped',
                tool: toolName,
                sessionId: sid,
                detail: `consecutive=${b.consecutive} total=${b.total}`,
            });
            // Tell the model to escalate directly (skip try→error→escalate).
            agent.inject(createUserMessage({
                content: [{ type: 'text', text: BREAKER_TRIPPED_HINT }],
                source: { kind: 'plugin', plugin: 'auto-mode' },
            }));
        }
        return 'rejected';
    }
    // 6. Breaker check
    if (breaker.isTripped(sid)) {
        logger.info(`breaker tripped → delegating to human for ${toolName}`);
        return next();
    }
    // 7. Classifier
    const route = resolveRoute(agent, config.classifier.provider, config.classifier.model);
    if (!route.provider || !route.model) {
        logger.warn(`no classifier route — ${config.failClosed ? 'rejecting (failClosed)' : 'falling back to approval chain'}`);
        return config.failClosed ? 'rejected' : next();
    }
    const environmentFacts = expandDefaults(config.rules.environment, 'environment');
    const transcript = truncateToChars(renderTranscript(derived, config.classifier.maxTranscriptMessages), config.classifyContextChars);
    // v0.13.0: pass the recovered command text to the approval-path classifier —
    // it previously saw only the justification prose, and picked stale reasons
    // from old context (the amplifier behind the cache-miss double classification).
    // v0.14.4: file tools additionally pass their recovered target paths so the
    // approval classifier sees which file an escalated write targets.
    const commandText = bashCommandOf(args);
    const input = promptInputOf({
        toolName,
        reason,
        userIntent,
        command: commandText || undefined,
        paths: isFileTool(toolName) ? collectPaths(args) : undefined,
    }, softAllowRules, softDenyRules, environmentFacts);
    logger.info(`classifying ${toolName}${reason ? ` (${reason})` : ''} via ${route.provider}/${route.model}`);
    const verdict = await classifyTwoStage(ctx, {
        system: buildSystemPrompt(input),
        user: buildUserMessage(input, transcript),
        provider: route.provider,
        model: route.model,
        temperature: config.classifier.temperature,
        maxTokens: config.classifier.maxTokens,
        signal,
        timeoutMs: config.timeoutMs,
        reasoningEffort: config.classifier.reasoningLevel,
        logger,
        onAttemptFail: (info) => {
            appendDecision({
                event: 'classifier-fail',
                tool: toolName,
                sessionId: sid,
                stage: info.stage,
                effort: info.effort ?? '',
                route: `${route.provider}/${route.model}`,
                detail: `${info.failure.message}${info.failure.code ? ` [${info.failure.code}]` : ''}${info.raw ? ` raw=${JSON.stringify(info.raw.slice(0, 120))}` : ''}`,
            });
        },
    }, 
    // v0.15.1: the fast filter must see the ACTION (command text / target
    // paths), not just the agent's justification — a reason-only summary let a
    // confidently worded justification skip the review entirely.
    actionSummaryOf(toolName, reason, commandText || undefined, input.paths));
    if (verdict) {
        logger.info(`classifier verdict: ${verdict.decision} — ${verdict.reason}`);
        switch (verdict.decision) {
            case 'allow':
                cache.put(sid, sig, 'ALLOW');
                breaker.resetConsecutive(sid);
                return 'allowed-once';
            case 'reject': {
                cache.put(sid, sig, 'DENY');
                const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
                if (justTripped) {
                    logger.warn(`breaker tripped for session ${sid}`);
                    const b = breaker.get(sid);
                    appendDecision({
                        event: 'breaker',
                        action: 'tripped',
                        tool: toolName,
                        sessionId: sid,
                        detail: `consecutive=${b.consecutive} total=${b.total}`,
                    });
                    // Tell the model to escalate directly (skip try→error→escalate).
                    agent.inject(createUserMessage({
                        content: [{ type: 'text', text: BREAKER_TRIPPED_HINT }],
                        source: { kind: 'plugin', plugin: 'auto-mode' },
                    }));
                }
                // Inject explanation so the model knows it was the reviewer, not a human.
                // Echo the model's own stated reason (req.reason carries the escalation
                // justification) so it can see what was rejected and reshape it.
                const echoed = req.reason ? ` Your stated reason: "${req.reason}" — the reviewer still judged this unsafe.` : '';
                agent.inject(createUserMessage({
                    content: [{
                            type: 'text',
                            text: `Auto mode blocked the ${toolName} call. Reviewer reason: ${verdict.reason}.${echoed} ` +
                                'The tool result may say "the user rejected" — in auto mode that usually means the reviewer, not a person. ' +
                                'Try a smaller or safer version, or ask the user for explicit permission.',
                        }],
                    source: { kind: 'plugin', plugin: 'auto-mode' },
                }));
                return 'rejected';
            }
        }
    }
    // 8. No verdict → fail-closed or fallback
    if (signal?.aborted)
        return 'cancelled';
    logger.warn(`classifier produced no verdict — ${config.failClosed ? 'rejecting (failClosed)' : 'falling back to approval chain'}`);
    return config.failClosed ? 'rejected' : next();
}
// ---- Apply ----
export function apply(ctx, rawConfig) {
    const config = Config(rawConfig);
    const logger = ctx.logger('auto-mode');
    const cache = new VerdictCache();
    const breaker = new Breaker();
    const bridge = new AllowPathBridge();
    // --- 1. Pre-execute gate ---
    if (config.preExecuteGate) {
        registerPreExecute(ctx, config, cache, breaker, logger, bridge);
    }
    // --- 2. Approval answerer ---
    ctx.on('approval/request', (req, next) => {
        if (!isAuto(ctx, req.agent.session))
            return next();
        const sid = String(req.agent.session.id ?? '?');
        // Breaker tripped → delegate to human. A human allow OR reject is an
        // authoritative, loop-breaking decision that re-arms auto mode and resets
        // the classifier-denial counters. (cancelled / unavailable = no real human
        // decision → keep the breaker tripped.)
        if (breaker.isTripped(sid)) {
            return next().then((outcome) => {
                if (outcome === 'allowed-once' || outcome === 'rejected') {
                    breaker.resume(sid);
                    const extra = outcome === 'allowed-once' ? 'human allowed' : 'human rejected';
                    appendDecision({
                        event: 'resume',
                        tool: req.toolName,
                        sessionId: sid,
                        detail: `${extra} → breaker reset`,
                    });
                    logger.info(`breaker reset after ${extra} for session ${sid}`);
                }
                return outcome;
            });
        }
        return decideAuto(ctx, config, req, next, cache, breaker, bridge, logger).then((outcome) => {
            appendDecision({
                event: 'decision',
                outcome,
                tool: req.toolName,
                sessionId: sid,
                // v0.14.0: carry the callId so an approval-path decision can be joined
                // precisely to its pre-execute gate record (previously only a
                // time-window approximation was possible when auditing, e.g. the
                // allow-then-reject contradiction pairs).
                callId: req.callId !== undefined && req.callId !== null ? String(req.callId) : undefined,
                reason: req.reason,
            });
            return outcome;
        });
    }, { prepend: true });
    // --- 3. System-prompt shadowing (Nuo-cl) ---
    ctx.inject(['systemPrompt'], (scope) => {
        ctx.on('agent/created', ({ agent }) => {
            agent.ctx.inject(['systemPrompt'], (agentScope) => {
                agentScope.systemPrompt.context({
                    name: 'approval:policy',
                    order: 115,
                    text: () => {
                        const policy = policyOf(ctx, agent.session) ?? 'ask';
                        if (policy === 'auto')
                            return AUTO_SENTENCE;
                        return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE;
                    },
                });
                agentScope.systemPrompt.context({
                    name: 'auto-mode:allowlist',
                    order: 116,
                    text: () => (isAuto(ctx, agent.session) ? ALLOWLIST_SENTENCE : ''),
                });
            });
        });
    });
    // --- 4. Commands ---
    ctx.inject(['commands'], (scope) => {
        scope.commands.register({
            name: 'auto',
            description: 'Switch this session to auto mode.',
            handler: ({ agent }) => {
                if (isAuto(ctx, agent.session))
                    return { kind: 'success', text: 'Already in auto mode.' };
                writeAutoMode(ctx, agent);
                return { kind: 'success', text: 'Auto mode enabled.' };
            },
        });
        scope.commands.register({
            name: 'auto-status',
            description: 'Show auto-mode diagnostics.',
            handler: ({ agent }) => {
                const auto = isAuto(ctx, agent.session);
                const state = permissionSnapshot(ctx, agent.session);
                const preset = state.preset;
                const approval = state.approval ?? ctx.approval.config.policy ?? 'ask';
                const b = breaker.get(String(agent.session.id ?? '?'));
                return {
                    kind: 'success',
                    text: `auto=${auto}; preset=${preset ?? 'none'}; approval=${approval}; breaker=${b.tripped ? 'TRIPPED' : `c=${b.consecutive}/t=${b.total}`}`,
                };
            },
        });
    });
    // --- 5. Boot log ---
    appendDecision({ event: 'boot', tool: '-', detail: `dsh-automode v${PKG_VERSION} active (failClosed=${config.failClosed}, preExecute=${config.preExecuteGate})` });
    logger.info(`dsh-automode v${PKG_VERSION} active (failClosed=${config.failClosed}, preExecute=${config.preExecuteGate})`);
}
