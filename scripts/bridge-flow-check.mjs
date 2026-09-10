/**
 * AllowPath bridge — end-to-end logic check against the COMPILED plugin
 * (lib/), no DSH runtime needed. Simulates the real call flow for an
 * escalated write to an allowlisted path:
 *
 *   tools/pre-execute  (write, danger-full-access, /tmp target)
 *     → curated allowPath → next() (allowed) + bridge.record(callId)
 *   approval/request   (same callId)
 *     → bridge.take(callId) → 'allowed-once'   ← the fix under test
 *
 * And a negative control: an approval/request with NO bridge record still
 * resolves 'rejected' (fail-closed, no classifier route) — proving the
 * bridge never weakens an unverified call.
 *
 * The decision log is redirected to a temp HOME so the real
 * ~/.dsh/auto-mode/decisions.jsonl is never touched.
 *
 *   node scripts/bridge-flow-check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the decision log BEFORE any appendDecision call (os.homedir is
// only read lazily inside appendDecision, so a fresh temp HOME is honored).
process.env.HOME = mkdtempSync(join(tmpdir(), 'dsh-automode-bridge-'));
if (process.platform === 'win32') process.env.USERPROFILE = process.env.HOME;

const { apply } = await import('../lib/index.js');

// ---- mock Cordis ctx: record listeners, no-op the rest ----
const listeners = { preExecute: [], approval: [] };
const ctx = {
  logger: () => ({ info() {}, warn() {} }),
  on(event, handler) {
    if (event === 'tools/pre-execute') listeners.preExecute.push(handler);
    else if (event === 'approval/request') listeners.approval.push(handler);
    return () => {};
  },
  inject() {},
  get() { return undefined; },
};

// ---- auto-mode session/agent ----
const events = [{ type: 'permission/preset', data: { preset: 'auto-mode' } }];
const session = {
  id: 'bridge-flow-test-session',
  get events() { return events; },
  append() {},
  header: { cwd: '/workspace' },
  requestHeader: () => ({ config: {} }),
  deriveMessages: () => [],
};
const agent = { session, options: {}, inject() {} };

apply(ctx, { allowPaths: ['/tmp/'] });

const [preExecute] = listeners.preExecute;
const [approval] = listeners.approval;
assert.ok(preExecute, 'tools/pre-execute listener registered');
assert.ok(approval, 'approval/request listener registered');

const abort = () => new AbortController().signal;
let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok - ${name}`); };

console.log('allowlisted escalation → pre-execute allows + approval grants');
{
  const exec = {
    name: 'write',
    arguments: {
      file_path: '/tmp/bridge-e2e-test.txt',
      content: 'bridge test',
      sandbox_permissions: 'danger-full-access',
      justification: 'E2E: allowlist bridge flow check',
    },
    agent,
    callId: 'call-allowlisted',
    signal: abort(),
  };
  const next = () => 'NEXT-CALLED';
  const outcome = await preExecute(exec, next);
  assert.equal(outcome, 'NEXT-CALLED', 'pre-execute must let the allowlisted write through');
  ok('tools/pre-execute returns next() (curated allowPath)');

  const req = {
    agent,
    toolName: 'write',
    callId: 'call-allowlisted',
    reason: 'escalate sandbox to danger-full-access: E2E: allowlist bridge flow check',
    signal: abort(),
  };
  const approved = await approval(req, () => 'UNUSED');
  assert.equal(approved, 'allowed-once', 'approval must grant the allowlisted escalation without classifier');
  ok('approval/request returns allowed-once for the bridged callId');
}

console.log('non-bridged escalation still fails closed (no blanket allowance)');
{
  const req = {
    agent,
    toolName: 'write',
    callId: 'call-not-bridged',
    reason: 'escalate sandbox to danger-full-access: something outside the allowlist',
    signal: abort(),
  };
  const rejected = await approval(req, () => 'UNUSED');
  assert.equal(rejected, 'rejected', 'an unbridged escalation must still be rejected (fail-closed)');
  ok('approval/request rejects a callId with no bridge record');
}

console.log('decision log (temp HOME) contains the expected trail');
{
  const logFile = join(process.env.HOME, '.dsh', 'auto-mode', 'decisions.jsonl');
  assert.ok(existsSync(logFile), `temp decisions.jsonl exists at ${logFile}`);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const text = lines.join('\n');
  assert.ok(text.includes('curated allowPath: /tmp/bridge-e2e-test.txt'), 'log has curated allowPath');
  assert.ok(text.includes('approval-bridge'), 'log has approval-bridge event');
  // The allowlisted call's decision must be allowed-once, never rejected.
  const allowlistedDecision = lines.find((l) => l.includes('E2E: allowlist bridge flow check') && l.includes('"event":"decision"'));
  assert.ok(allowlistedDecision, 'log has a decision for the allowlisted call');
  assert.ok(allowlistedDecision.includes('"outcome":"allowed-once"'), 'allowlisted decision is allowed-once');
  // The non-bridged control call must still be rejected (no blanket allowance).
  const controlDecision = lines.find((l) => l.includes('outside the allowlist') && l.includes('"event":"decision"'));
  assert.ok(controlDecision, 'log has a decision for the control call');
  assert.ok(controlDecision.includes('"outcome":"rejected"'), 'control decision is rejected');
  ok('decisions.jsonl: allowlisted → curated allowPath + approval-bridge + allowed-once; control → rejected');
}

console.log(`\nbridge flow check passed (${passed} assertions)`);
