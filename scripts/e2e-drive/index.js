/**
 * Dev-only E2E driver: one REAL model turn inside an isolated DSH instance.
 *
 * Loaded as a profile plugin (`scripts/e2e-isolated-home.sh setup --with-driver`).
 * It boots the host, creates a real agent + session, runs the real `/auto`
 * command, sends one real turn, and writes down what actually happened — the
 * session's live derived messages plus this plugin's own `renderUserIntent()`
 * output over them, with an OPTIONAL red control (a previous build's lib).
 *
 * Everything is env-driven so one script covers the chains the project's E2E
 * gate needs:
 *
 *   E2E_PROMPT        the user message of the turn (required to do anything)
 *   E2E_ASK_ANSWER    answer the model's ask_user_question with this label
 *                     (registers a local answerer in the AGENT's scope — the
 *                     request waterfall is agent-scoped; a root listener sees
 *                     nothing and the tool reports "no answerer")
 *   E2E_ASK_TOOL=0    do not mount the host's real ask_user_question tool
 *   E2E_OLD_LIB       a directory holding a PREVIOUS build's lib/ (red control:
 *                     same live messages, previous implementation)
 *   E2E_PROVIDER/E2E_MODEL   route for the created agent (the profile's
 *                     `agent-default-model` row is NOT inherited by
 *                     programmatically created agents — pass both)
 *   E2E_OUT           results JSON path (default /tmp/dsh-e2e-drive.json)
 *   E2E_DEADLINE_MS   give up waiting for the turn after this (default 240000)
 *   E2E_CWD           session working directory (default: a temp dir)
 *
 * Why a driver instead of a browser: some behaviour only exists INSIDE a turn
 * (the host rejects an approval request raised outside one), and a browser can
 * not be asked to run one exact command.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Resolve a host package the way the RUNNING instance would: a profile's
 * node_modules usually carries no `@deepseek-ai/*` (they resolve out of the CLI
 * tree), so plain bare imports from this file would fail. `E2E_DSH_MODULES`
 * overrides everything.
 */
const require_ = createRequire(import.meta.url);
function hostModule(spec) {
  const roots = [];
  if (process.env.E2E_DSH_MODULES) roots.push(process.env.E2E_DSH_MODULES);
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
  try {
    for (const name of readdirSync(join(dshHome, 'profiles'))) roots.push(join(dshHome, 'profiles', name));
  } catch { /* no profiles yet */ }
  // Walk up from the CLI entrypoint to the node_modules that owns @deepseek-ai.
  let dir = process.argv[1] ? dirname(process.argv[1]) : '';
  for (let i = 0; i < 8 && dir; i += 1) {
    roots.push(dir);
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  roots.push(process.cwd());
  for (const base of roots) {
    try {
      return pathToFileURL(require_.resolve(spec, { paths: [base] })).href;
    } catch { /* try the next root */ }
  }
  return pathToFileURL(require_.resolve(spec)).href; // repo devDependencies, last resort
}

const { createUserMessage } = await import(hostModule('@deepseek-ai/dsh-llm'));

const OUT = process.env.E2E_OUT ?? '/tmp/dsh-e2e-drive.json';
const WS = process.env.E2E_CWD ?? '/tmp/dsh-e2e-ws';
const PROMPT = process.env.E2E_PROMPT ?? '';
const ASK_ANSWER = process.env.E2E_ASK_ANSWER ?? '';
const MOUNT_ASK_TOOL = (process.env.E2E_ASK_TOOL ?? '1') !== '0';
const OLD_LIB = process.env.E2E_OLD_LIB ?? '';
const PROVIDER = process.env.E2E_PROVIDER ?? 'deepseek-official';
const MODEL = process.env.E2E_MODEL ?? 'deepseek-flash';
const DEADLINE = Number(process.env.E2E_DEADLINE_MS ?? 240_000);

export const name = 'e2e-drive';

export function apply(ctx) {
  // A profile whose app never blocks exit would drop the turn mid-flight.
  const keepAlive = setTimeout(() => {}, 600_000);
  ctx.on('dispose', () => clearTimeout(keepAlive));

  const results = [];
  const record = (step, data) => {
    results.push({ step, ...data });
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  };
  const intentOf = (mod, messages) => {
    try {
      return mod.renderUserIntent(messages, 10);
    } catch (error) {
      return `<error: ${String(error?.message ?? error)}>`;
    }
  };

  if (!PROMPT) {
    record('idle', { note: 'E2E_PROMPT empty — driver loaded but did nothing' });
    return;
  }

  ctx.inject(['agents', 'commands', 'tools'], async (c) => {
    try {
      mkdirSync(WS, { recursive: true });
      const handle = await createAgent(c, `e2e-${Date.now().toString(36)}`);
      const agent = handle?.agent ?? handle;
      record('agent-created', { sessionId: String(agent?.session?.id ?? '?') });
      const cmd = await c.commands.execute(agent, '/auto', [], AbortSignal.timeout(60_000));
      record('auto-command', { result: JSON.stringify(cmd ?? null).slice(0, 200) });

      record('turn-prompt', { prompt: PROMPT });
      agent.send(createUserMessage({
        content: [{ type: 'text', text: PROMPT }],
        source: { kind: 'user' },
      }), 'next-turn', true);

      const started = Date.now();
      let last = -1;
      let stable = 0;
      while (Date.now() - started < DEADLINE) {
        await new Promise((r) => setTimeout(r, 3000));
        const n = agent.session.deriveMessages().length;
        if (n === last) stable += 1; else { stable = 0; last = n; }
        if (stable >= 3 && n > 0) break;
      }

      const messages = agent.session.deriveMessages();
      const roles = {};
      for (const m of messages) roles[m.role] = (roles[m.role] ?? 0) + 1;
      record('live-messages', { count: messages.length, roles });

      const current = await import(new URL('../../lib/classifier.js', import.meta.url).href);
      record('renderUserIntent (current lib, LIVE messages)', { intent: intentOf(current, messages) });
      if (OLD_LIB) {
        const old = await import(new URL('file://' + OLD_LIB.replace(/\/$/, '') + '/classifier.js').href);
        record('renderUserIntent (previous lib, same LIVE messages)', { intent: intentOf(old, messages) });
      }
    } catch (error) {
      record('error', { message: String(error?.message ?? error).slice(0, 500) });
    }
  });

  /** The `agents` service exists before the loop installs its factory — wait for it. */
  const createAgent = async (c, sessionId) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return await c.agents.create({
          sessionId,
          meta: { cwd: WS, agentPreset: 'standard' },
          agentOptions: { provider: PROVIDER, model: MODEL },
          setup: async (agentCtx) => {
            if (ASK_ANSWER) {
              // The question waterfall is AGENT-scoped: register here, not on the root ctx.
              agentCtx.on('user-questions/request', (request, next) => {
                const questions = request?.questions ?? [];
                if (questions.length === 0) return next();
                record('ask-requested', { questions: questions.map((q) => q.question).slice(0, 2) });
                return { answers: questions.map((q) => ({ id: q.id, selected: [ASK_ANSWER] })) };
              });
            }
            if (MOUNT_ASK_TOOL) {
              // Model-facing tools live in the agent-preset realm on web profiles;
              // the host-plane registry answers UNKNOWN_TOOL without this.
              const ask = await import(hostModule('@deepseek-ai/dsh-tool-ask-user'));
              agentCtx.plugin(ask);
            }
          },
        });
      } catch (error) {
        if (!/no agent factory/.test(String(error?.message ?? error))) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('the agent factory never registered');
  };
}
