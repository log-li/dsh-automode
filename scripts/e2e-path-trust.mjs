#!/usr/bin/env node
/**
 * End-to-end check of the CHANGED path-trust behaviour, driven against the
 * compiled plugin (`lib/` — the artifact that actually runs) with a faithful
 * host mock. No DSH runtime and no API key needed, so it can run anywhere;
 * the real-model classifier E2E is the separate, opt-in `npm run test:e2e`.
 *
 *   node scripts/e2e-path-trust.mjs
 *
 * It covers the three things the unit suite cannot:
 *   1. what the MODEL actually sees — the full `auto-mode:allowlist` text is
 *      rendered through the real `systemPrompt.context` wiring and printed in
 *      full (per the project rule: audit the complete model-visible output,
 *      not just the field you changed);
 *   2. the allowlisted-escalation happy path end to end — gate → curated
 *      allowPath → approval bridge → `allowed-once`, with zero classifier;
 *   3. the four trust-proof tightenings from v0.15.3, each asserted to NOT take
 *      that fast path: a composite `mkdir` outside the roots, a relative
 *      destination after `cd`-ing outside, an unresolved `$VAR` destination, and
 *      a path-prefixed command impersonating a benign utility.
 *
 * Exit 1 on any failed expectation. The decision log is redirected to a temp
 * HOME so the real ~/.dsh/auto-mode/decisions.jsonl is never touched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'dsh-automode-pathtrust-'));

const { apply } = await import('../lib/index.js');

// ---- host mock (records listeners + system-prompt contexts) ----------------
const listeners = { preExecute: [], approval: [] };
const captured = [];
let onAgentCreated;
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  on(event, handler) {
    if (event === 'tools/pre-execute') listeners.preExecute.push(handler);
    else if (event === 'approval/request') listeners.approval.push(handler);
    else if (event === 'agent/created') onAgentCreated = handler;
    return () => {};
  },
  inject(deps, cb) {
    if (deps.includes('systemPrompt')) cb({});
  },
  get() {
    return undefined;
  },
};

const TRUSTED = '/tmp/trusted/';
apply(ctx, { allowPaths: [TRUSTED] });

const mkSession = (preset) => {
  const events = [{ type: 'permission/preset', data: { preset } }];
  return {
    id: `e2e-${preset}`,
    get events() { return events; },
    append() {},
    header: { cwd: '/workspace' },
    requestHeader: () => ({ config: {} }),
    deriveMessages: () => [],
  };
};

function makeAgent(preset) {
  const agent = {
    session: mkSession(preset),
    options: {},
    inject() {},
    ctx: {
      inject(deps, cb) {
        if (deps.includes('systemPrompt')) {
          cb({ systemPrompt: { context: (c) => captured.push(c) } });
        }
      },
    },
  };
  onAgentCreated({ agent });
  return agent;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}\n        ${err.message}`);
  }
}

const [preExecute, approval] = [listeners.preExecute[0], listeners.approval[0]];
assert.ok(preExecute && approval, 'plugin must register both listeners');

/** Drive ONE call through gate → approval, returning both outcomes. */
async function drive(callId, command) {
  const agent = makeAgent('auto-mode');
  const gate = await preExecute(
    {
      name: 'bash',
      callId,
      arguments: { command, sandbox_permissions: 'danger-full-access', justification: `e2e ${callId}` },
      agent,
    },
    async () => 'NEXT',
  );
  const approvalOutcome = await approval(
    { agent, toolName: 'bash', callId, reason: `escalate sandbox to danger-full-access: e2e ${callId}` },
    async () => 'HUMAN',
  );
  return { gate, approvalOutcome };
}

const log = () => readFileSync(join(process.env.HOME, '.dsh/auto-mode/decisions.jsonl'), 'utf8');

// ---- 1. what the model sees ------------------------------------------------
console.log('1) model-visible system prompt (auto-mode session)');
const autoAgent = makeAgent('auto-mode');
const section = captured.find((c) => c.name === 'auto-mode:allowlist');
assert.ok(section, 'the auto-mode:allowlist context must be registered');
const text = section.text();
console.log('----- BEGIN auto-mode:allowlist -----');
console.log(text);
console.log('----- END auto-mode:allowlist -----');
check('the rendered guidance carries the first-attempt escalation rule', () => {
  assert.match(text, /FIRST attempt/);
  assert.match(text, /danger-full-access/);
  assert.match(text, /auto-approved with no review/);
});
check('the rendered guidance warns against both anti-patterns', () => {
  assert.ok(/do not run it bare/i.test(text), 'bare-then-escalate anti-pattern missing');
  assert.ok(/never skip the escalation/i.test(text), 'fear-of-a-prompt anti-pattern missing');
});
check('a non-auto session receives an empty allowlist section (scoping)', async () => {
  captured.length = 0;
  makeAgent('workspace-write');
  const other = captured.find((c) => c.name === 'auto-mode:allowlist');
  assert.ok(other, 'context must still be registered');
  assert.equal(other.text(), '', 'non-auto presets must not get the guidance');
});

// ---- 2. allowlisted escalation: the fast path still works ------------------
console.log('2) allowlisted path — zero-review escalation (control)');
const control = await drive('call-ok', `cp /tmp/a ${TRUSTED}b`);
check('gate lets a fully-trusted escalation through', () => {
  assert.notEqual(control.gate?.kind, 'deny', `gate denied: ${JSON.stringify(control.gate)}`);
});
check('approval grants it via the bridge, without a classifier', () => {
  assert.equal(control.approvalOutcome, 'allowed-once');
});
check('the audit trail shows the deterministic path', () => {
  const l = log();
  assert.ok(l.includes('curated allowPath'), 'expected a curated allowPath event');
  assert.ok(l.includes('approval-bridge'), 'expected an approval-bridge event');
});

// ---- 3. v0.15.3 tightenings must NOT take the fast path --------------------
console.log('3) trust-proof tightenings — must fall through to review');
const hardening = [
  ['call-mkdir', 'git -C /tmp/trusted/repo commit -m x && mkdir -p /tmp/outside'],
  ['call-cdrel', 'cd /tmp/outside && cp a workspace/evil'],
  ['call-var', 'git -C /tmp/trusted/repo commit -m m && cp a "$TMPDIR/y"'],
  ['call-impersonate', `cp a ${TRUSTED}dest && ./echo hi`],
];
for (const [callId, command] of hardening) {
  const before = log().length;
  const { gate, approvalOutcome } = await drive(callId, command);
  check(`${callId}: not bridged, not auto-approved (${JSON.stringify(gate?.kind)})`, () => {
    assert.notEqual(approvalOutcome, 'allowed-once', 'the composite WAS auto-approved — trust proof leaked');
    const tail = log().slice(before);
    assert.ok(!tail.includes('curated allowPath'), 'a curated allowPath event was written');
  });
}

console.log(
  failures === 0
    ? '\npath-trust E2E passed: guidance rendered + fast path intact + 4 tightenings hold'
    : `\npath-trust E2E FAILED: ${failures} expectation(s)`,
);
process.exit(failures === 0 ? 0 : 1);
