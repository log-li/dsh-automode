import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { compileRegex, bashCommandOf, compileGlob, matchAllow, isCompositeShell, bashWriteDestinations, isFileTool, collectPaths, collectDenyPaths, scanDenyBand } from './bands.js';
import { VerdictCache, hashString } from './cache.js';
import { actionSummaryOf, classifyFailureCategory, classifyTwoStage, renderUserIntent, resolveRoute } from './classifier.js';
import { buildSystemPrompt, buildUserMessage, promptInputOf } from './prompt.js';
import { expandDefaults } from './config.js';
import { permissionSnapshot } from './permission-state.js';
import { appendDecision } from './log.js';
import { realpathSync } from 'node:fs';
import { resolve, sep, join, dirname, basename } from 'node:path';
// ---- File-path trust helpers (Bug 5 real-path check; Bug 6 tighter allowPaths) ----
/** Expand `~` and `${HOME}`/`$HOME` in a path. */
function expandHome(p) {
    const home = process.env.HOME ?? '';
    return p.replace(/^~(?=$|\/)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
}
/**
 * Best-effort realpath (symlink resolution). When the path itself doesn't
 * exist yet (a not-yet-written target at gate time), resolve the nearest
 * existing ancestor's realpath and re-append the remaining tail — so targets
 * under a symlinked allowPath root (e.g. macOS `/tmp` → `/private/tmp`) still
 * match their trust root instead of falling back to a lexical path that skips
 * the symlink.
 */
function realpathSafe(p) {
    try {
        return realpathSync(p);
    }
    catch {
        let rest = '';
        let cur = p;
        for (;;) {
            try {
                return join(realpathSync(cur), rest);
            }
            catch {
                // keep walking up
            }
            const next = dirname(cur);
            if (next === cur)
                return resolve(p); // hit the root — bail to lexical
            rest = join(basename(cur), rest);
            cur = next;
        }
    }
}
/** Expand allowPaths into absolute, symlink-resolved trust roots (cwd + allowPaths). */
function trustRoots(allowPaths, cwd) {
    const roots = [];
    if (cwd)
        roots.push(realpathSafe(cwd));
    for (const p of allowPaths) {
        const expanded = realpathSafe(expandHome(p));
        if (expanded)
            roots.push(expanded);
    }
    return [...new Set(roots)];
}
/** Whether `p` (symlink-resolved) is under any trust root.
 * Relative paths are resolved against `base` (the session working directory)
 * before the realpath/prefix match — the host process cwd must never be the
 * resolution base for a session-relative file-tool path, or every in-workspace
 * relative path (e.g. `_internal/log.md`) is misjudged out-of-tree (2026-09-01
 * Bug A; see spec). Without `base`, behavior is the legacy process-cwd resolve. */
export function isInsideTrusted(p, roots, base) {
    if (!p)
        return false;
    const abs = base ? resolve(base, p) : p;
    const rp = realpathSafe(abs);
    return roots.some((root) => rp === root || rp.startsWith(root.endsWith(sep) ? root : root + sep));
}
/** Denial envelope — reaches the model verbatim.
 * `modelExplanation` is the main model's own stated reason for the action
 * (the justification from the tool call), echoed back so the model can see
 * what the reviewer rejected and reshape it into a safer form. */
function denialText(category, reason, modelExplanation) {
    const echoed = modelExplanation
        ? ` Your stated reason: "${modelExplanation}" — the reviewer still judged this unsafe; reshape the action into a safer form.`
        : '';
    return `dsh-automode denied this action (${category}): ${reason}.${echoed} ` +
        'Try a safer alternative. If there is NO safer alternative, STOP retrying and ask the user for explicit permission ' +
        '(a denied action will keep failing; only explicit user approval lets a later attempt pass).';
}
/**
 * Injected at the moment the breaker trips so the model stops doing the
 * "try at current level → hit a denied error → then escalate" round-trip
 * and instead requests the sandbox escalation directly, surfacing the human
 * approval window immediately.
 */
export const BREAKER_TRIPPED_HINT = 'Auto mode circuit breaker tripped: the safety classifier denied several actions in a row, so auto mode has paused and this and later approvals go to a human. ' +
    'For any action that needs sandbox escalation (writing/editing outside the workspace, or commands needing more permission), request `danger-full-access` sandbox_permissions DIRECTLY on your first attempt — a human will be asked to approve it. ' +
    'Do NOT first try at the current permission level, hit a "denied" error, and then escalate; that wastes a round-trip. Go straight to the escalation request.';
/** CC errors-doc wording for transient classifier failures. */
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
/**
 * Register the pre-execute gate as a tools/pre-execute listener.
 */
export function registerPreExecute(ctx, config, cache, breaker, logger, bridge) {
    // Pre-compile regex patterns for performance
    const denyPatterns = config.deny.map(compileRegex);
    const allowGlobs = config.allow.map(compileGlob);
    // Expand $defaults in prose rules
    const softDenyRules = expandDefaults(config.rules.deny, 'soft_deny');
    const softAllowRules = expandDefaults(config.rules.allow, 'soft_allow');
    const environmentFacts = expandDefaults(config.rules.environment, 'environment');
    ctx.on('tools/pre-execute', async (exec, next) => {
        let toolName = '';
        let sid = '';
        try {
            if (!exec || typeof exec.name !== 'string')
                return next();
            toolName = exec.name;
            const session = exec.agent?.session;
            if (!session)
                return next();
            // Preset gate: this guardrail only applies to auto-mode sessions.
            // In other presets (read-only / workspace-write / danger-full-access),
            // the auto-mode pre-execute gate is a no-op so it does not contradict
            // the user's chosen sandbox — e.g. "full access" must not be denied here.
            if (permissionSnapshot(ctx, session).preset !== 'auto-mode') {
                return next();
            }
            sid = String(session.id ?? '?');
            const commandText = bashCommandOf(exec.arguments);
            // 1. Read-only tools → allow (unless deny matched)
            if (config.readOnlyTools.includes(toolName)) {
                // Check deny first even for read-only (reading .ssh is blocked).
                // For file tools, scan the *target paths* (not content/command text), so
                // a read of a sensitive file path is caught while a file whose *content*
                // merely mentions a deny word is not (shared haystack + shared scan,
                // v0.15.1 — scanDenyBand owns the prose scope for BOTH enforcement points).
                const denyHit = scanDenyBand(toolName, exec.arguments, denyPatterns);
                if (denyHit !== null) {
                    appendDecision({
                        event: 'pre-execute-deny',
                        tool: toolName,
                        sessionId: sid,
                        // v0.14.0: carry the command/target context so a deny hit can be
                        // audited for false positives (previously only the pattern was
                        // recorded — e.g. `credentials` hits could not be distinguished
                        // from a harmless mention).
                        detail: `matched deny pattern /${denyHit}/${isFileTool(toolName) ? ` targets=${JSON.stringify(collectDenyPaths(exec.arguments))}` : commandText ? ` cmd=${JSON.stringify(commandText.slice(0, 150))}` : ''}`,
                    });
                    return {
                        kind: 'deny',
                        reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                    };
                }
                return next(); // read-only, no deny → allow
            }
            // 2. Deny band (regex hard-reject) — same shared scan as the read-only
            // path above, so the prose scope can never diverge between them.
            const denyHit = scanDenyBand(toolName, exec.arguments, denyPatterns);
            if (denyHit !== null) {
                appendDecision({
                    event: 'pre-execute-deny',
                    tool: toolName,
                    sessionId: sid,
                    detail: `matched deny pattern /${denyHit}/${isFileTool(toolName) ? ` targets=${JSON.stringify(collectDenyPaths(exec.arguments))}` : commandText ? ` cmd=${JSON.stringify(commandText.slice(0, 150))}` : ''}`,
                });
                return {
                    kind: 'deny',
                    reason: denialText('deny', `matched deny pattern /${denyHit}/`),
                };
            }
            // 3. Allow band (prefix glob, non-composite)
            if (commandText && !isCompositeShell(commandText)) {
                const allowHit = matchAllow(allowGlobs, commandText);
                if (allowHit !== null) {
                    appendDecision({
                        event: 'pre-execute-allow',
                        tool: toolName,
                        sessionId: sid,
                        detail: `matched allow glob /${allowHit}/`,
                    });
                    return next(); // allow
                }
            }
            // 4. Real trust check for file tools (Bug 5). in-tree OR curated allowPath → allow.
            //    We only take this shortcut when there is NO sandbox escalation request — if the
            //    agent is asking to widen the sandbox (even to an in-tree target), that is itself
            //    a risk signal and must reach the classifier (preserves the original conservatism).
            const isFileToolCall = isFileTool(toolName);
            const perm = exec.arguments && typeof exec.arguments === 'object'
                ? exec.arguments.sandbox_permissions
                : undefined;
            const isEscalation = typeof perm === 'string' && perm !== '';
            const targetPaths = isFileToolCall ? collectPaths(exec.arguments) : [];
            const roots = trustRoots(config.allowPaths, session.header?.cwd);
            const wsBase = session.header?.cwd;
            const inTrusted = isFileToolCall && targetPaths.length > 0
                && targetPaths.every((p) => isInsideTrusted(p, roots, wsBase));
            if (config.allowInsideWorkingDirectory && isFileToolCall && inTrusted && !isEscalation) {
                appendDecision({
                    event: 'pre-execute-allow',
                    tool: toolName,
                    sessionId: sid,
                    detail: `in-tree / allowPath file op (path resolved): ${targetPaths.join(', ')}`,
                });
                return next(); // real in-tree → allow
            }
            // 5. Escalation intent OR out-of-workspace file op → classifier pre-screen.
            const isOutOfTreeFileOp = isFileToolCall && targetPaths.length > 0 && !inTrusted;
            // Bash write-commands (cp/mv/rsync/...) expose their destination; feed it to
            // the curated allowPath check so exporting into a trusted dir is trusted.
            const bashTargets = isFileToolCall ? [] : bashWriteDestinations(commandText, session.header?.cwd);
            // Diagnose why a file/bash op is (or isn't) classified: record the gate state.
            if (isFileToolCall || (commandText && isEscalation)) {
                const argsKeys = exec.arguments && typeof exec.arguments === 'object'
                    ? Object.keys(exec.arguments).join(',')
                    : typeof exec.arguments;
                appendDecision({
                    event: isFileToolCall ? 'pre-execute-fileop' : 'pre-execute-bashop',
                    tool: toolName,
                    sessionId: sid,
                    detail: `esc=${isEscalation} ${isFileToolCall ? `targets=${JSON.stringify(targetPaths)}` : `bashDests=${JSON.stringify(bashTargets)}`} inTree=${inTrusted} outOfTree=${isOutOfTreeFileOp} breaker=${breaker.isTripped(sid)} cwd=${session.header?.cwd ?? '?'} argsKeys=${argsKeys} cmdHead=${JSON.stringify(commandText.slice(0, 150))}`,
                });
            }
            if ((isEscalation || isOutOfTreeFileOp) && !breaker.isTripped(sid)) {
                const escReason = isEscalation
                    ? `escalate sandbox to ${perm}: ${String(exec.arguments?.justification ?? commandText ?? toolName)}`
                    : `file operation outside trusted workspace: ${targetPaths.join(', ')}${exec.arguments?.justification ? ` — model explanation: ${String(exec.arguments.justification)}` : ''}`;
                // Curated allowPaths trust (Bug 6): real symlink-resolved prefix match, not substring.
                // Covers file tools (targetPaths) AND bash write-commands (bashTargets destination).
                const allowPathTargets = isFileToolCall ? targetPaths : bashTargets;
                if (allowPathTargets.length > 0 && allowPathTargets.every((p) => isInsideTrusted(p, roots, wsBase))) {
                    // v0.14.0: the trust roots include the session cwd (`trustRoots`),
                    // so an in-workspace target with an escalation request also lands
                    // here — distinguish the two in the audit trail instead of labeling
                    // every hit "curated allowPath" (which reads as a config.allowPaths
                    // match). Behavior is identical: deterministic allow + bridge.
                    const configuredRoots = trustRoots(config.allowPaths);
                    const hitConfigured = allowPathTargets.every((p) => isInsideTrusted(p, configuredRoots, wsBase));
                    appendDecision({
                        event: 'pre-execute-allow',
                        tool: toolName,
                        sessionId: sid,
                        detail: `${hitConfigured ? 'curated allowPath' : 'workspace in-tree escalation (session cwd in trust roots)'}: ${allowPathTargets.join(', ')}`,
                    });
                    // Approval bridge (2026-08-31): the approval/request payload does not
                    // carry args/paths, so the approval answerer cannot re-run this exact
                    // allowPath proof. Record the deterministic verdict against the call's
                    // callId — `approveEscalation` forwards the SAME callId into the
                    // approval request — so `decideAuto` can grant the escalation without
                    // classifier review. Deny patterns already ran first above; the breaker
                    // is not tripped here (this branch is inside the !breaker.isTripped
                    // block), so the bridge never bypasses either guard.
                    if (typeof exec?.callId === 'string' && exec.callId !== '') {
                        bridge.record(exec.callId, toolName, allowPathTargets);
                    }
                    return next();
                }
                // User intent is part of the verdict key: the classifier weighs the user's
                // recent DIRECT instructions, so a fresh explicit authorization must not be
                // swallowed by a cached DENY — hash the intent into the signature.
                const derived = session.deriveMessages();
                const userIntent = renderUserIntent(derived, config.classifier.maxIntentMessages);
                const intentHash = hashString(userIntent);
                // Cache check (Bug 3: maxArgsChars wired into the signature).
                const sig = VerdictCache.sig(toolName, escReason, exec.arguments, config.maxArgsChars, intentHash);
                const cached = cache.get(sid, sig);
                if (cached === 'DENY') {
                    // Cached classifier denies count toward the breaker too (Bug 2026-08-25:
                    // otherwise repeated identical escalation attempts never trip it, and the
                    // breaker-gated human-approval path for sandbox escalation is unreachable).
                    const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
                    appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'a prior identical action was judged unsafe' });
                    if (justTripped) {
                        const b = breaker.get(sid);
                        appendDecision({
                            event: 'breaker',
                            action: 'tripped',
                            tool: toolName,
                            sessionId: sid,
                            detail: `consecutive=${b.consecutive} total=${b.total}`,
                        });
                        // Tell the model to escalate directly (skip try→error→escalate).
                        if (exec.agent) {
                            try {
                                exec.agent.inject(createUserMessage({
                                    content: [{ type: 'text', text: BREAKER_TRIPPED_HINT }],
                                    source: { kind: 'plugin', plugin: 'auto-mode' },
                                }));
                            }
                            catch { /* best effort */ }
                        }
                    }
                    return {
                        kind: 'deny',
                        reason: denialText('classifier:unsafe', 'a prior identical action was judged unsafe'),
                    };
                }
                if (cached === 'ALLOW') {
                    appendDecision({ event: 'pre-execute-allow', tool: toolName, sessionId: sid, detail: 'verdict cache ALLOW' });
                    return next();
                }
                // Classify (two-stage, Bug 1; user intent, CC-style). No transcript here — it is a
                // bounded pre-screen, but we still feed the user's recent instructions for intent.
                const route = resolveRoute(exec.agent, config.classifier.provider, config.classifier.model);
                if (!route.provider || !route.model) {
                    if (config.failClosed) {
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'no classifier route' });
                        return {
                            kind: 'deny',
                            reason: classifierUnavailableText('no classifier route', toolName),
                        };
                    }
                    return next();
                }
                const input = promptInputOf(
                // v0.14.4: escalated file-tool calls must show the classifier WHICH
                // file is targeted (file tools carry no command — without paths the
                // reviewer saw only the justification prose). bash escalations must
                // also see the raw command (re-review finding: escReason alone hides
                // it behind the justification).
                {
                    toolName,
                    reason: escReason,
                    userIntent,
                    command: commandText || undefined,
                    paths: isFileToolCall ? targetPaths : undefined,
                }, softAllowRules, softDenyRules, environmentFacts);
                const verdict = await classifyTwoStage(ctx, {
                    system: buildSystemPrompt(input),
                    user: buildUserMessage(input, ''),
                    provider: route.provider,
                    model: route.model,
                    temperature: config.classifier.temperature,
                    maxTokens: config.classifier.maxTokens,
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
                // v0.15.1: give the fast filter the ACTION (command / paths), not
                // only the escalation justification — see actionSummaryOf().
                actionSummaryOf(toolName, escReason, commandText || undefined, isFileToolCall ? targetPaths : undefined));
                if (verdict) {
                    cache.put(sid, sig, verdict.decision === 'allow' ? 'ALLOW' : 'DENY');
                    if (verdict.decision === 'reject') {
                        const justTripped = breaker.countDeny(sid, config.breakerConsecutive, config.breakerTotal);
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: verdict.reason });
                        if (justTripped) {
                            const b = breaker.get(sid);
                            appendDecision({
                                event: 'breaker',
                                action: 'tripped',
                                tool: toolName,
                                sessionId: sid,
                                detail: `consecutive=${b.consecutive} total=${b.total}`,
                            });
                            // Tell the model to escalate directly (skip try→error→escalate).
                            if (exec.agent) {
                                try {
                                    exec.agent.inject(createUserMessage({
                                        content: [{ type: 'text', text: BREAKER_TRIPPED_HINT }],
                                        source: { kind: 'plugin', plugin: 'auto-mode' },
                                    }));
                                }
                                catch { /* best effort */ }
                            }
                        }
                        const modelExplanation = exec.arguments && typeof exec.arguments === 'object'
                            ? String(exec.arguments.justification ?? '')
                            : '';
                        return {
                            kind: 'deny',
                            reason: denialText('classifier:unsafe', `${verdict.reason} — reshape the command so it fits the allowlist, or drop the escalation`, modelExplanation),
                        };
                    }
                    if (verdict.decision === 'allow') {
                        breaker.resetConsecutive(sid);
                        appendDecision({ event: 'pre-execute-allow', tool: toolName, sessionId: sid, detail: verdict.reason });
                        return next();
                    }
                }
                else {
                    // Classifier failure → fail-closed (Bug 1/3: timeout etc. now surface here).
                    if (config.failClosed) {
                        appendDecision({ event: 'pre-execute-deny', tool: toolName, sessionId: sid, reason: 'classifier returned no verdict' });
                        return {
                            kind: 'deny',
                            reason: classifierUnavailableText('classifier returned no verdict', toolName),
                        };
                    }
                }
            }
        }
        catch (error) {
            const msg = String(error?.message ?? error);
            const stack = String(error?.stack ?? '');
            logger.warn(`pre-execute error (fail-open): ${msg}`);
            appendDecision({
                event: 'pre-execute-fail-open',
                tool: toolName,
                sessionId: sid,
                detail: `${msg}${stack ? `\n${stack.slice(0, 500)}` : ''}`,
            });
        }
        return next();
    }, { prepend: true });
}
