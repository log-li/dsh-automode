/**
 * Smoke tests for the pure logic of dsh-auto-mode — runs against the
 * compiled lib/ output with plain node, no DSH runtime needed.
 *
 *   node scripts/smoke.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAllowRule, findDenyRule, isAllowlisted, patternMatches } from '../lib/rules.js';
import { parseVerdict, renderTranscript, renderUserIntent, restoreToolCallArgs } from '../lib/classifier.js';
import { buildSystemPrompt, buildUserMessage } from '../lib/prompt.js';
import { isAuto, writeAutoMode } from '../lib/index.js';
import { Breaker } from '../lib/breaker.js';
import { VerdictCache, hashString } from '../lib/cache.js';
import { AllowPathBridge } from '../lib/bridge.js';
import { tokenizeShell, bashWriteDestinations } from '../lib/bands.js';
import { isInsideTrusted } from '../lib/pre-execute.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('rules.js');
test('exact tool name matches case-insensitively', () => {
  assert.equal(findAllowRule(['read'], 'Read', undefined), 'read');
  assert.equal(findAllowRule(['READ'], 'read', undefined), 'READ');
});
test('tool:pattern matches reason substring', () => {
  const reason = '[sandbox: file access denied under read-only mode]';
  assert.equal(findAllowRule(['read:/etc/'], 'read', reason), undefined);
  assert.equal(findAllowRule(['read:file access denied'], 'read', reason), 'read:file access denied');
});
test('wildcard pattern matches whole reason', () => {
  assert.equal(patternMatches('/etc/*', '/etc/passwd'), true);
  assert.equal(patternMatches('/etc/*', '/var/log'), false);
  assert.equal(patternMatches('rm -rf *', 'rm -rf /'), true);
});
test('star tool matches any tool', () => {
  assert.equal(findDenyRule(['*:delete'], 'write', 'delete file'), '*:delete');
  assert.equal(findDenyRule(['*'], 'anything', undefined), '*');
});
test('deny and allow are independent', () => {
  assert.equal(findDenyRule(['read:/etc/*'], 'read', '/etc/passwd'), 'read:/etc/*');
  assert.equal(findAllowRule(['read:/etc/*'], 'read', '/home/x'), undefined);
});
test('allowlist is case-insensitive', () => {
  assert.equal(isAllowlisted('Read', ['read', 'glob']), true);
  assert.equal(isAllowlisted('pwsh', ['read', 'glob']), false);
});

console.log('classifier.js');
test('parses two-value decision verdict (ask is normalized to reject)', () => {
  assert.deepEqual(
    parseVerdict('{"decision": "allow", "reason": "safe read"}'),
    { decision: 'allow', reason: 'safe read' },
  );
  assert.deepEqual(
    parseVerdict('{"decision": "reject", "reason": "dangerous"}'),
    { decision: 'reject', reason: 'dangerous' },
  );
  // Two-state (0.8.0): legacy "ask" output fails closed → reject.
  assert.deepEqual(
    parseVerdict('{"decision": "ask", "reason": "may be intended"}'),
    { decision: 'reject', reason: 'uncertain (ask) — treated as reject (fail-closed)' },
  );
});
test('parses JSON inside markdown fence', () => {
  const reply = '```json\n{"decision": "reject", "reason": "rm -rf is destructive"}\n```';
  assert.deepEqual(parseVerdict(reply), {
    decision: 'reject',
    reason: 'rm -rf is destructive',
  });
});
test('tolerates surrounding prose', () => {
  const reply = 'Here is my verdict:\n{"decision": "allow", "reason": "ok"}\nHope that helps.';
  assert.deepEqual(parseVerdict(reply), { decision: 'allow', reason: 'ok' });
});
test('legacy boolean verdict still parses', () => {
  assert.deepEqual(parseVerdict('{"allow": true, "reason": "safe read"}'), {
    decision: 'allow',
    reason: 'safe read',
  });
  assert.deepEqual(parseVerdict('{"allow": false, "reason": "x"}'), {
    decision: 'reject',
    reason: 'x',
  });
  assert.deepEqual(parseVerdict('{"allow":true} trailing'), {
    decision: 'allow',
    reason: 'classifier decision: allow',
  });
});
test('falls back to decision/allow token scan', () => {
  // NOTE: the refactored keyword fallback has no `ask` signal, so a bare
  // `decision = "ask"` (non-JSON) yields null (fail-closed upstream). The JSON
  // path normalizes `{"decision":"ask"}` to reject (see two-value test above).
  assert.equal(parseVerdict('decision = "ask" definitely'), null);
  // CAVEAT (fail-open): the keyword scan matches the bare word "allow", so
  // `allow = false` is read as allow, not reject. JSON `{"allow":false}` is the
  // correct reject path. Documenting actual behavior; do not treat this as the
  // safety-correct answer for prose negation.
  assert.deepEqual(parseVerdict('allow = false, definitely'), {
    decision: 'allow',
    reason: 'classifier decision: allow',
  });
});
test('invalid verdict values reject the whole reply', () => {
  // JSON `{"allow":"yes"}` is not a typed boolean: the strict boolean fields
  // don't fire, so it falls through to the keyword scan which sees "allow"/"yes"
  // and returns allow (loose). JSON `{"decision":"maybe"}` has no deny/allow
  // signal and yields null (fail-closed upstream).
  assert.deepEqual(parseVerdict('{"allow": "yes", "reason": "x"}'), {
    decision: 'allow',
    reason: 'classifier decision: allow',
  });
  assert.equal(parseVerdict('{"decision": "maybe", "reason": "x"}'), null);
});
test('empty reply yields null', () => {
  assert.equal(parseVerdict('   '), null);
});
test('renderTranscript keeps the trailing window', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'm1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'm2' }] },
    { role: 'user', content: [{ type: 'text', text: 'm3' }] },
  ];
  const out = renderTranscript(messages, 2);
  assert.ok(out.includes('m2'));
  assert.ok(out.includes('m3'));
  assert.ok(!out.includes('m1'));
});
test('renderTranscript renders tool calls and results', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a.txt"}', id: 'c1' }],
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'file contents' }] }],
    },
  ];
  const out = renderTranscript(messages, 10);
  assert.ok(out.includes('[tool call: read {"path":"a.txt"}]'));
  assert.ok(out.includes('[tool result: file contents]'));
});

console.log('restoreToolCallArgs (v0.13.0 cache-signature parity on the approval path)');
test('recovers arguments of the exact callId (object and JSON-string forms)', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'bash', arguments: '{"command":"read_config"}', id: 'other' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"trash ~/.agents/skills/see-image","description":"remove obsolete skill"}', id: 'c1' },
        { type: 'tool-call', name: 'bash', arguments: { command: 'cp a /dst' }, id: 'c2' },
      ],
    },
  ];
  assert.deepEqual(restoreToolCallArgs(messages, 'c1'), {
    command: 'trash ~/.agents/skills/see-image',
    description: 'remove obsolete skill',
  });
  assert.deepEqual(restoreToolCallArgs(messages, 'c2'), { command: 'cp a /dst' });
  assert.equal(restoreToolCallArgs(messages, 'missing'), undefined);
  assert.equal(restoreToolCallArgs(messages, undefined), undefined);
});
test('a call outside the window and an unparseable payload fall back safely', () => {
  assert.equal(restoreToolCallArgs([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'c1'), undefined);
  assert.equal(
    restoreToolCallArgs([{ role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{not-json', id: 'c1' }] }], 'c1'),
    '{not-json', // caller then falls back to the reason-based signature
  );
});

console.log('renderUserIntent (tool-based authorization, spec 2026-08-31)');
test('direct human text is intent; ordinary tool results are not', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 skill push 上去' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'c-read', isError: false, content: [{ type: 'text', text: 'file contents' }] }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'auto-mode' }, content: [{ type: 'text', text: 'auto mode enabled' }] },
  ];
  const out = renderUserIntent(messages, 10);
  assert.ok(out.includes('把 skill push 上去'), 'direct text must be intent');
  assert.ok(!out.includes('file contents'), 'ordinary tool result must NOT be intent');
  assert.ok(!out.includes('auto mode enabled'), 'plugin injection must NOT be intent');
});
test('ask_user_question answer is intent (parsed selected options)', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'ask1', name: 'ask_user_question', arguments: '{"questions":[{"id":"q1","question":"授权推送？","options":["授权推送"]}]}' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'ask1', isError: false, content: [{ type: 'text', text: '{"answers":[{"id":"q1","selected":["授权推送"]}]}' }] }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '另外把日志也整理一下' }] },
  ];
  const out = renderUserIntent(messages, 10);
  assert.ok(out.includes('授权推送'), 'ask_user_question selected answer must be intent');
  assert.ok(out.includes('另外把日志也整理一下'), 'direct text stays intent');
  assert.ok(!out.includes('{"answers"'), 'raw JSON payload should not leak verbatim');
});
test('ask_user_question error result is NOT intent (a cancel is not a grant)', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'ask2', name: 'ask_user_question', arguments: '{}' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'ask2', isError: true, content: [{ type: 'text', text: '{"answers":[]}' }] }] },
  ];
  const out = renderUserIntent(messages, 10);
  assert.ok(!out.includes('answers'), 'errored ask_user_question must NOT be intent');
});
test('a tool-based grant changes the intent hash (invalidates stale DENY cache)', () => {
  const before = [
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'c-push', isError: false, content: [{ type: 'text', text: 'denied' }] }] },
  ];
  const after = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'ask3', name: 'ask_user_question', arguments: '{}' }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'ask3', isError: false, content: [{ type: 'text', text: '{"answers":[{"id":"q1","selected":["授权推送"]}]}' }] }] },
  ];
  assert.notEqual(
    hashString(renderUserIntent(before, 10)),
    hashString(renderUserIntent(after, 10)),
    'a fresh tool-based authorization must change the cache signature',
  );
});

console.log('prompt.js');
test('system prompt embeds the three rule sections', () => {
  const sys = buildSystemPrompt({
    toolName: 'write',
    reason: 'x',
    allowRules: ['read'],
    denyRules: ['pwsh:rm -rf'],
    environmentFacts: ['Windows host'],
  });
  assert.ok(sys.includes('<standing_approvals>'));
  assert.ok(sys.includes('- read'));
  assert.ok(sys.includes('<standing_rejections>'));
  assert.ok(sys.includes('- pwsh:rm -rf'));
  assert.ok(sys.includes('<environment_notes>'));
  assert.ok(sys.includes('- Windows host'));
});
test('user message carries transcript and action', () => {
  const user = buildUserMessage(
    { toolName: 'pwsh', reason: 'needs admin', allowRules: [], denyRules: [], environmentFacts: [] },
    '<conversation stuff>',
  );
  assert.ok(user.includes('<conversation_so_far>'));
  assert.ok(user.includes('tool: pwsh'));
  assert.ok(user.includes('reason: needs admin'));
});

console.log('auto mode state (index.js)');
function makeAutoHarness({ withService = true, preset, approval, legacyEvents = true, projections = true } = {}) {
  const events = [];
  if (preset !== undefined) events.push({ type: 'permission/preset', data: { preset } });
  if (approval !== undefined) events.push({ type: 'approval/policy', data: { policy: approval } });
  const session = {
    append(type, data) {
      events.push({ type, data });
    },
  };
  // dsh <= 0.1.1-rc.2 exposes the durable log as `session.events`.
  if (legacyEvents) {
    Object.defineProperty(session, 'events', {
      get() {
        return events;
      },
    });
  }
  const injected = [];
  const agent = {
    session,
    inject(message) {
      injected.push(message);
    },
  };
  const service = {
    set(session_, name) {
      if (name !== 'auto-mode') throw new Error(`unknown preset ${name}`);
      session_.append('permission/preset', { preset: name });
    },
  };
  const ctx = {
    logger() {
      return { info() {}, warn() {} };
    },
    get(name) {
      return name === 'permissionPresets' && withService ? service : undefined;
    },
    approval: { config: { policy: 'ask' } },
  };
  // dsh >= 0.1.5-rc.1 reads the durable `permissions` session projection instead.
  if (projections) {
    ctx.sessionProjections = {
      stateOf(target, key) {
        if (key !== 'permissions' || target !== session) return undefined;
        let presetValue = null;
        let sandbox = null;
        let approvalValue = null;
        for (const event of events) {
          if (event.type === 'permission/preset') presetValue = event.data.preset;
          if (event.type === 'sandbox/mode') sandbox = event.data.mode;
          if (event.type === 'approval/policy') approvalValue = event.data.policy;
        }
        return { preset: presetValue, sandbox, approval: approvalValue };
      },
    };
  }
  return { events, session, agent, injected, ctx, service };
}

test('isAuto follows the last permission/preset value', () => {
  const { session, ctx } = makeAutoHarness({ preset: 'auto-mode' });
  assert.equal(isAuto(ctx, session), true);
  session.append('permission/preset', { preset: 'read-only' });
  assert.equal(isAuto(ctx, session), false);
  session.append('permission/preset', { preset: 'auto-mode' });
  assert.equal(isAuto(ctx, session), true);
});

test('isAuto reads the permissions projection on dsh 0.1.5-rc.1 (no session.events)', () => {
  // Regression: 0.1.5-rc.1 removed `session.events` (reads yield undefined).
  // The old effectivePermissionPreset(session.events) call threw
  // "Cannot read properties of undefined (reading 'length')" during
  // systemPrompt.assemble() → agent/pre-step, killing every turn.
  const { session, ctx } = makeAutoHarness({ preset: 'auto-mode', legacyEvents: false });
  assert.equal(session.events, undefined);
  assert.equal(isAuto(ctx, session), true);
  session.append('permission/preset', { preset: 'read-only' });
  assert.equal(isAuto(ctx, session), false);
});

test('isAuto falls back to the event log on pre-0.1.5 cores', () => {
  const { session, ctx } = makeAutoHarness({ preset: 'auto-mode', projections: false });
  assert.equal(isAuto(ctx, session), true);
});

test('writeAutoMode uses the public permissionPresets.set path', () => {
  const { events, agent, injected, ctx } = makeAutoHarness();
  writeAutoMode(ctx, agent);
  assert.deepEqual(events.map((e) => e.type), ['permission/preset']);
  assert.equal(events[0].data.preset, 'auto-mode');
  assert.equal(injected.length, 1);
});

test('writeAutoMode falls back to direct core-valid knob events', () => {
  const { events, agent, ctx } = makeAutoHarness({ withService: false });
  writeAutoMode(ctx, agent);
  assert.deepEqual(events.map((e) => e.type), [
    'permission/preset',
    'sandbox/mode',
  ]);
  assert.equal(events[0].data.preset, 'auto-mode');
  assert.equal(events[1].data.mode, 'workspace-write');
  // No approval/policy event is appended when the effective policy is
  // already the auto-mode preset's core-valid "ask".
});

test('writeAutoMode fallback switches a never policy back to ask', () => {
  const { events, agent, ctx } = makeAutoHarness({ withService: false, approval: 'never' });
  writeAutoMode(ctx, agent);
  const policies = events.filter((e) => e.type === 'approval/policy').map((e) => e.data.policy);
  assert.deepEqual(policies, ['never', 'ask']);
});

test('writeAutoMode is a no-op when auto mode is already selected', () => {
  const { events, agent, injected, ctx } = makeAutoHarness({ preset: 'auto-mode' });
  writeAutoMode(ctx, agent);
  assert.equal(events.length, 1);
  assert.equal(injected.length, 0);
});

console.log('\nbreaker.js');
test('breaker trips after N consecutive denies', () => {
  const b = new Breaker();
  const sid = 's1';
  assert.equal(b.countDeny(sid, 3, 20), false);
  assert.equal(b.countDeny(sid, 3, 20), false);
  assert.equal(b.countDeny(sid, 3, 20), true); // 3rd consecutive → trip
  assert.equal(b.isTripped(sid), true);
  assert.deepEqual(b.get(sid), { consecutive: 3, total: 3, tripped: true });
});
test('breaker trips after N total denies (non-consecutive)', () => {
  const b = new Breaker();
  const sid = 's2';
  let tripped = false;
  for (let i = 0; i < 20; i++) tripped = b.countDeny(sid, 100, 20); // only total threshold
  assert.equal(tripped, true);
  assert.equal(b.isTripped(sid), true);
  assert.equal(b.get(sid).total, 20);
});
test('resetConsecutive clears only the consecutive counter', () => {
  const b = new Breaker();
  const sid = 's3';
  b.countDeny(sid, 3, 20); // c=1,t=1
  b.countDeny(sid, 3, 20); // c=2,t=2
  b.resetConsecutive(sid);
  assert.deepEqual(b.get(sid), { consecutive: 0, total: 2, tripped: false });
});
test('resume resets counters and clears tripped', () => {
  const b = new Breaker();
  const sid = 's4';
  b.countDeny(sid, 3, 20);
  b.countDeny(sid, 3, 20);
  b.countDeny(sid, 3, 20); // trip
  assert.equal(b.isTripped(sid), true);
  b.resume(sid);
  assert.deepEqual(b.get(sid), { consecutive: 0, total: 0, tripped: false });
  assert.equal(b.isTripped(sid), false);
});

console.log('cache.js (intent-aware verdict cache)');
test('hashString is deterministic', () => {
  assert.equal(hashString('allow writing to OneDrive'), hashString('allow writing to OneDrive'));
  assert.equal(hashString(''), hashString(''));
  assert.notEqual(hashString('allow'), hashString('deny'));
});
test('sig appends intent hash and differs when intent changes', () => {
  const base = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200);
  const withA = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200, hashString('allow OneDrive'));
  const withB = VerdictCache.sig('bash', 'escalate', { command: 'cp a.docx /dest' }, 200, hashString('deny OneDrive'));
  assert.notEqual(withA, withB);          // different intent → different key
  assert.notEqual(withA, base);           // intent-hashed differs from legacy
  assert.ok(withA.startsWith(`${base}|intent:`));
});
test('cache get/put respects the intent-hashed signature', () => {
  const c = new VerdictCache();
  const sid = 's-intent';
  const s1 = VerdictCache.sig('bash', 'r', { command: 'cp a /d' }, 200, hashString('intent1'));
  const s2 = VerdictCache.sig('bash', 'r', { command: 'cp a /d' }, 200, hashString('intent2'));
  c.put(sid, s1, 'DENY');
  assert.equal(c.get(sid, s1), 'DENY');
  assert.equal(c.get(sid, s2), null); // new intent → cache miss (user grant re-classifies)
});
test('v0.13.0: approval-path sig (recovered args) matches pre-execute sig — reason text is not part of the key', () => {
  // Regression for the 2026-09-11 double-classification bug: the pre-execute
  // gate signs with the command text, the approval path used to sign with the
  // escalation-reason text (args=undefined) → keys never matched → 100% cache
  // miss → a second, worse-informed classifier run. Once the approval path
  // recovers the real args (restoreToolCallArgs), both keys must be identical
  // even when the reason strings differ.
  const intent = hashString('user asked to remove the obsolete skill');
  const gateSig = VerdictCache.sig('bash', 'escalate sandbox to workspace-write: remove obsolete skill', { command: '~/bin/trash ~/.agents/skills/see-image' }, 200, intent);
  const approvalSig = VerdictCache.sig('bash', 'a completely different justification', { command: '~/bin/trash ~/.agents/skills/see-image' }, 200, intent);
  assert.equal(approvalSig, gateSig);
  // And the cache write from the gate is hit by the approval path:
  const c = new VerdictCache();
  const sid = 's-callid';
  c.put(sid, gateSig, 'ALLOW');
  assert.equal(c.get(sid, approvalSig), 'ALLOW');
});

console.log('bands.js (bashWriteDestinations)');
test('cp/mv destination is the last positional', () => {
  assert.deepEqual(
    bashWriteDestinations('cp file.docx "/Users/x/OneDrive/Proposal/GRF 2026 a.docx"'),
    ['/Users/x/OneDrive/Proposal/GRF 2026 a.docx'],
  );
  assert.deepEqual(bashWriteDestinations('cp -r src /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('mv a b /Users/x/OneDrive/Proposal/f'), ['/Users/x/OneDrive/Proposal/f']);
  // Parens in a QUOTED filename are literal, not a subshell → destination extracted
  assert.deepEqual(
    bashWriteDestinations('cp "/src/GRF 2026 Methods - Ver 2.0 (copy).docx" "/Users/x/OneDrive/Proposal/GRF 2026 Methods - Ver 2.0 (copy).docx"'),
    ['/Users/x/OneDrive/Proposal/GRF 2026 Methods - Ver 2.0 (copy).docx'],
  );
});
test('cp -t / --target-directory form', () => {
  assert.deepEqual(bashWriteDestinations('cp -t /Users/x/OneDrive/Proposal a b'), ['/Users/x/OneDrive/Proposal']);
  assert.deepEqual(bashWriteDestinations('cp --target-directory=/Users/x/OneDrive/Proposal a b'), ['/Users/x/OneDrive/Proposal']);
});
test('rsync/install destination', () => {
  assert.deepEqual(bashWriteDestinations('rsync -av --delete /src/ /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('install -m 755 src /Users/x/OneDrive/Proposal/bin'), ['/Users/x/OneDrive/Proposal/bin']);
});
test('tar/unzip extract target (-C / -d)', () => {
  assert.deepEqual(bashWriteDestinations('tar -xzf x.tar.gz -C /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('unzip x.zip -d /Users/x/OneDrive/Proposal/'), ['/Users/x/OneDrive/Proposal/']);
  assert.deepEqual(bashWriteDestinations('tar xf x.tar'), []); // extracts to cwd, not an explicit dest
});
test('curl -o / wget -O target', () => {
  assert.deepEqual(bashWriteDestinations('curl -o /Users/x/OneDrive/Proposal/f https://example.com/a'), ['/Users/x/OneDrive/Proposal/f']);
  assert.deepEqual(bashWriteDestinations('wget -O /Users/x/OneDrive/Proposal/f https://example.com/a'), ['/Users/x/OneDrive/Proposal/f']);
});
test('git clone target dir', () => {
  assert.deepEqual(
    bashWriteDestinations('git clone https://github.com/x/y /Users/x/OneDrive/Proposal/repo'),
    ['/Users/x/OneDrive/Proposal/repo'],
  );
  assert.deepEqual(bashWriteDestinations('git clone https://github.com/x/y'), []);
});
test('non-write commands and IRRECOVERABLE deletion are NOT allowlisted', () => {
  assert.deepEqual(bashWriteDestinations('ls /Users/x/OneDrive/Proposal'), []);
  assert.deepEqual(bashWriteDestinations('cat /etc/passwd'), []);
  assert.deepEqual(bashWriteDestinations('rm -rf /Users/x/OneDrive/Proposal'), []);
  assert.deepEqual(bashWriteDestinations('rm /Users/x/OneDrive/Proposal/f'), []);
});
test('v0.13.0: recoverable `trash` targets ARE extracted for allowPath', () => {
  // trash (freedesktop recycle bin) is a recoverable delete: its positional
  // targets are extracted so the allowPath gate requires ALL of them inside the
  // trusted roots (system paths stay hard-denied; rm/shred stay unextracted).
  assert.deepEqual(bashWriteDestinations('trash /Users/x/OneDrive/Proposal/f'), ['/Users/x/OneDrive/Proposal/f']);
  assert.deepEqual(bashWriteDestinations('trash f1 f2'), ['f1', 'f2']);
  assert.deepEqual(bashWriteDestinations('trash -f /Users/x/OneDrive/Proposal/f'), ['/Users/x/OneDrive/Proposal/f']);
});
test('v0.13.0: `~` tilde expansion on write destinations (incl. wrapper scripts)', () => {
  const home = process.env.HOME;
  assert.ok(home, 'HOME must be set for tilde tests');
  assert.deepEqual(bashWriteDestinations('cp a ~/dst'), [join(home, 'dst')]);
  assert.deepEqual(
    bashWriteDestinations('~/bin/trash ~/.agents/skills/see-image'),
    [join(home, '.agents/skills/see-image')],
  );
  assert.deepEqual(
    bashWriteDestinations('git clone https://github.com/x/y ~/OneDrive/repo'),
    [join(home, 'OneDrive/repo')],
  );
});
test('redirect/empty commands are skipped', () => {
  assert.deepEqual(bashWriteDestinations('echo hi > /Users/x/OneDrive/Proposal/f'), []);
  assert.deepEqual(bashWriteDestinations(''), []);
});

console.log('bands.js (bashWriteDestinations — composite support, spec 2026-09-01 Issue B)');
test('temp→swap composite export dance yields the real destinations ($VAR expansion)', () => {
  const dests = bashWriteDestinations(
    'DIR="/Users/x/OneDrive/Proposal"; cp a b_temp && (trash b; true) && mv b_temp "$DIR/b" && ls',
  );
  assert.ok(dests.includes('b_temp'), `dests=${JSON.stringify(dests)}`);
  assert.ok(dests.includes('/Users/x/OneDrive/Proposal/b'), `dests=${JSON.stringify(dests)}`);
});
test('composite with benign trailing segments still yields the write dest', () => {
  assert.deepEqual(bashWriteDestinations('cp a /dest && echo done'), ['/dest']);
  assert.deepEqual(bashWriteDestinations('cp a /dest; ls -la'), ['/dest']);
  assert.deepEqual(bashWriteDestinations('export D=/x; cp a "$D/f"'), ['/x/f']);
});
test('side-effect / interpreter / unknown commands invalidate the composite fast path', () => {
  assert.deepEqual(bashWriteDestinations('pkill -f node && cp a /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('rm x && cp a /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('curl -o /tmp/e https://x/e && bash /tmp/e'), []);
  assert.deepEqual(bashWriteDestinations('cp a /tmp/b && cd -'), []); // `cd -` ($OLDPWD) is unpredictable
  assert.deepEqual(bashWriteDestinations('cp a /tmp/b && (rm -rf x)'), []);
});
test('cd is a tracked benign navigator (not an invalidator), plus git write-resolution', () => {
  // `cd <dir>` rides along and updates the effective cwd; `cd -` still fails closed.
  assert.deepEqual(bashWriteDestinations('cp a /tmp/b && cd /tmp'), ['/tmp/b']);
  // git add/commit/push write into the repo's `.git`, so the allowPath-checkable
  // destination is the repository root resolved from the `cd` (or `-C`) context.
  assert.deepEqual(
    bashWriteDestinations('cd /Users/logan/.agents && git add skills/a.md && git commit -m "m"'),
    ['/Users/logan/.agents'],
  );
  assert.deepEqual(
    bashWriteDestinations('cd /Users/logan/.agents && git add -A && git commit -q -m "x"'),
    ['/Users/logan/.agents'],
  );
  assert.deepEqual(
    bashWriteDestinations('cd /Users/logan/.agents && git push origin main 2>&1 | tail -3'),
    ['/Users/logan/.agents'],
  );
  assert.deepEqual(bashWriteDestinations('git -C /Users/logan/.agents add .'), ['/Users/logan/.agents']);
  assert.deepEqual(bashWriteDestinations('git add .', '/Users/logan/.agents'), ['/Users/logan/.agents']);
  // `-C ~/…` normalizes `~` to the absolute repo root (HOME expansion).
  assert.deepEqual(
    bashWriteDestinations('git -C ~/.agents add .'),
    [join(process.env.HOME, '.agents')],
  );
  // history-rewrite / deletion git commands are NOT allowPath-trusted.
  assert.deepEqual(bashWriteDestinations('git reset --hard HEAD'), []);
  assert.deepEqual(bashWriteDestinations('cd /Users/logan/.agents && git clean -f'), []);
  assert.deepEqual(bashWriteDestinations('cd /Users/logan/.agents && rm -rf x'), []);
});
test('redirection in any segment invalidates the composite fast path', () => {
  assert.deepEqual(bashWriteDestinations('cp a /tmp/b && echo hi >> /tmp/log'), []);
});
test('command substitution (backtick / $() / <()) is never allowPath-trusted', () => {
  assert.deepEqual(bashWriteDestinations('cp a $(rm -rf /) /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('cp a `rm -rf /` /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('cp a <(rm -rf /) /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('cp a "/tmp/$(dirname x)/f" /tmp/b'), []);
  assert.deepEqual(bashWriteDestinations('D="$(pwd)"; cp a "$D/b"'), []);
  // $() inside double quotes still executes in bash — must fall back too.
  assert.deepEqual(bashWriteDestinations('cp "a$(echo x).txt" /tmp/b'), []);
  // A literal $VAR expansion (the Issue B feature) still works.
  assert.deepEqual(bashWriteDestinations('D=/x; cp a "$D/f"'), ['/x/f']);
});
test('benign utilities ride along the composite fast path (documented semantics)', () => {
  // v0.13.0: `trash` is no longer a benign ride-along — its targets are
  // extracted too, so both the cp write-destination and the trash target must
  // be inside the trusted roots for the composite to take the allowPath path.
  assert.deepEqual(bashWriteDestinations('cp a /dest && trash /x/f'), ['/dest', '/x/f']);
  assert.deepEqual(bashWriteDestinations('cp a /dest && mkdir -p /x'), ['/dest']);
});
test('quoted separators inside filenames are not split points', () => {
  const dests = bashWriteDestinations('cp "a;b.txt" "/Users/x/OneDrive/Proposal/f;x.docx" && ls');
  assert.deepEqual(dests, ['/Users/x/OneDrive/Proposal/f;x.docx']);
});

console.log('pre-execute.js (isInsideTrusted — workspace-relative resolution, spec 2026-09-01 Bug A)');
const ws = mkdtempSync(join(tmpdir(), 'am-ws-'));
writeFileSync(join(ws, 'inner.md'), 'x');
const wsReal = realpathSync(ws);
const roots = [wsReal];
try {
  test('relative in-workspace path resolves against base → in-tree', () => {
    assert.equal(isInsideTrusted('_internal/log.md', roots, ws), true);
    assert.equal(isInsideTrusted('workspace/JC-STEM-2026/plan-draft/a.md', roots, ws), true);
  });
  test('relative path escaping the workspace via .. is NOT in-tree', () => {
    assert.equal(isInsideTrusted('../outside.md', roots, ws), false);
    assert.equal(isInsideTrusted('../../etc/passwd', roots, ws), false);
  });
  test('absolute paths are unchanged with or without base', () => {
    assert.equal(isInsideTrusted(join(ws, 'inner.md'), roots), true);
    assert.equal(isInsideTrusted(join(ws, 'inner.md'), roots, ws), true);
    assert.equal(isInsideTrusted('/etc/passwd', roots, ws), false);
  });
  test('no base keeps the legacy process-cwd behavior (relative NOT in-tree)', () => {
    assert.equal(isInsideTrusted('_internal/log.md', roots), false);
  });
} finally {
  rmSync(ws, { recursive: true, force: true });
}

console.log('bridge.js (AllowPathBridge — pre-execute → approval callId bridge)');
test('record then take consumes the entry for the same callId + tool', () => {
  const b = new AllowPathBridge();
  b.record('call-1', 'write', ['/tmp/a.txt']);
  assert.equal(b.size, 1);
  const hit = b.take('call-1', 'write');
  assert.ok(hit);
  assert.equal(hit.toolName, 'write');
  assert.deepEqual(hit.paths, ['/tmp/a.txt']);
  // consume-on-read: a second take for the same callId is a miss
  assert.equal(b.take('call-1', 'write'), undefined);
  assert.equal(b.size, 0);
});
test('take requires the exact callId (no cross-call leakage)', () => {
  const b = new AllowPathBridge();
  b.record('call-1', 'write', ['/tmp/a.txt']);
  assert.equal(b.take('call-2', 'write'), undefined); // different callId → miss
  assert.equal(b.take('call-1', 'write')?.toolName, 'write'); // original still intact
});
test('take requires the same tool name (no cross-tool reuse)', () => {
  const b = new AllowPathBridge();
  b.record('call-1', 'write', ['/tmp/a.txt']);
  assert.equal(b.take('call-1', 'edit'), undefined); // wrong tool → miss
  assert.equal(b.take('call-1', 'write')?.toolName, 'write');
});
test('stale records are not granted (TTL)', () => {
  const b = new AllowPathBridge();
  b.record('call-1', 'write', ['/tmp/a.txt']);
  const realNow = Date.now;
  Date.now = () => realNow() + 70_000; // 70s later > 60s TTL
  try {
    assert.equal(b.take('call-1', 'write'), undefined);
  } finally {
    Date.now = realNow;
  }
});
test('empty/absent callId never records or grants', () => {
  const b = new AllowPathBridge();
  b.record('', 'write', ['/tmp/a.txt']);
  assert.equal(b.size, 0);
  assert.equal(b.take(undefined, 'write'), undefined);
});
test('size stays bounded at the cap', () => {
  const b = new AllowPathBridge();
  for (let i = 0; i < 2100; i++) b.record(`call-${i}`, 'write', ['/tmp/x']);
  assert.ok(b.size <= 2000, `size=${b.size} should be capped at 2000`);
  // the oldest entry was evicted; recent entries survive
  assert.equal(b.take('call-0', 'write'), undefined);
  assert.equal(b.take('call-2099', 'write')?.toolName, 'write');
});
test('clear empties the bridge', () => {
  const b = new AllowPathBridge();
  b.record('call-1', 'write', ['/tmp/a.txt']);
  b.clear();
  assert.equal(b.size, 0);
  assert.equal(b.take('call-1', 'write'), undefined);
});

console.log(`\nall ${passed} smoke tests passed`);