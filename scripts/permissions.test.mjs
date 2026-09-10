import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Decision logs from the test must stay out of the user's profile on Windows.
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'automode-permissions-'));
const { isAuto, writeAutoMode, apply } = await import('../lib/index.js');
const { approvalPolicy, sandboxMode, hasLegacyPermissionFolds } = await import('../lib/permissions.js');

function harness({ preset = 'auto-mode', fail = false } = {}) {
  const listeners = new Map();
  const session = { id: 'test', events: [], append() { throw Error('must not write raw events'); } };
  const service = { current(s) { assert.equal(s, session); if (fail) throw Error('projection unavailable'); return preset; }, set() { throw Error('unknown preset'); } };
  const ctx = {
    get(name) { return { permissionPresets: service, approval: { effectivePolicy: () => 'never' }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }[name]; },
    on(name, callback) { listeners.set(name, callback); },
    logger() { return { info() {}, warn() {} }; },
    inject() {},
  };
  return { session, ctx, service, listeners };
}

test('service state wins over stale event history and deployment defaults', () => {
  const { session, ctx, service } = harness({ preset: 'read-only' });
  session.events.push({ type: 'permission/preset', data: { preset: 'auto-mode' } });
  assert.equal(isAuto(session, ctx), false);
  service.current = () => 'auto-mode';
  session.events.length = 0;
  assert.equal(isAuto(session, ctx), true);
  assert.equal(approvalPolicy(ctx, session), 'never');
  assert.equal(sandboxMode(ctx, session), 'read-only');
});

test('unavailable projection is not interpreted as a different preset', () => {
  const { session, ctx } = harness({ fail: true });
  assert.throws(() => isAuto(session, ctx), /projection unavailable/);
});

test('both enforcement points fail closed when preset lookup fails', async () => {
  const { session, ctx, listeners } = harness({ fail: true });
  apply(ctx, { failClosed: false });
  const next = () => { throw Error('must not delegate an unknown preset'); };
  const agent = { session };
  const result = await listeners.get('tools/pre-execute')({ name: 'write', arguments: {}, agent }, next);
  assert.equal(result.kind, 'deny');
  assert.match(result.reason, /projection unavailable/);
  assert.equal(await listeners.get('approval/request')({ agent }, next), 'rejected');
});

test('non-auto sessions continue through both enforcement points', async () => {
  const { session, ctx, listeners } = harness({ preset: 'read-only' });
  apply(ctx, {});
  const agent = { session };
  assert.equal(await listeners.get('tools/pre-execute')({ name: 'write', arguments: {}, agent }, () => 'next'), 'next');
  assert.equal(await listeners.get('approval/request')({ agent }, () => 'next'), 'next');
});

test('modern host setter errors never fall back to raw permission writes', { skip: hasLegacyPermissionFolds() }, () => {
  const { session, ctx } = harness({ preset: 'read-only' });
  assert.throws(() => writeAutoMode(ctx, { session, inject() { throw Error('must not announce success'); } }), /unknown preset/);
});
