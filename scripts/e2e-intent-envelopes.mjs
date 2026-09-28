/**
 * Opt-in E2E: does the intent window READ THE ENVELOPE THE HOST ACTUALLY SENDS? (v0.16.1)
 *
 * Why this exists: `renderUserIntent` reads messages the harness derives from a
 * session log, and the harness changed that envelope under the plugin once
 * already — `dsh >= 0.1.7` (session format v4) turned tool results from a
 * `role: 'user'` message wrapping a `tool-result` block into a first-class
 * `role: 'tool'` message. Reading only the old shape silently dropped every
 * tool-based grant, so a user who confirmed a command through
 * `ask_user_question` saw it rejected again as unauthorized.
 *
 * Fixtures in `npm test` encode the shapes we BELIEVE the host produces. This
 * script checks the belief against the host's own code and REAL history:
 *   1. real session logs are restored through the harness's own format catalog
 *      (including the released v3 -> v4 migration that lifts the old wrapper), so
 *      the message list is the one the harness derives, not one we assembled;
 *   2. the repo's `lib/classifier.js` must render each real answer into the
 *      intent window (GREEN);
 *   3. the previous release's `lib/classifier.js` — extracted from git, run over
 *      the SAME message list — must NOT see it for v4 history (RED control), so
 *      a green result cannot come from a check that can never fail.
 *
 * It needs a harness on session format >= 4 plus real logs that contain an
 * `ask_user_question` answer, so it is opt-in and SKIPs with guidance instead of
 * failing, exactly like `npm run test:v4`.
 *
 *   DSH_V4_NODE_MODULES=/tmp/dsh-v4-cli/node_modules npm run test:intent
 *
 * Anchors (first hit wins): $DSH_V4_NODE_MODULES, $DSH_HOME/profiles/<name>/node_modules,
 * `npm root -g`. The red control uses `E2E_PREFIX_REF` (default: the v0.16.0 release tag).
 *
 * A SKIP means "nothing was verified" and must never look like a pass.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = '@deepseek-ai/dsh-session-format-catalog';
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PREFIX_REF = process.env.E2E_PREFIX_REF ?? 'v0.16.0';
const MAX_LOGS = Number(process.env.E2E_MAX_LOGS ?? 150);
const MAX_CASES = Number(process.env.E2E_MAX_CASES ?? 5);
const SHELL = { PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` };

const skip = (why, how) => {
  console.log(`SKIP test:intent — ${why}`);
  if (how) console.log(`  ${how}`);
  process.exitCode = 0;
};

const fail = (...lines) => {
  console.log(`FAIL test:intent — ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`  ${line}`);
  process.exitCode = 1;
};

/** Locate a catalog whose current format is >= v4 (never silently accept an older one). */
async function findCurrentCatalog() {
  const roots = [];
  if (process.env.DSH_V4_NODE_MODULES) roots.push(process.env.DSH_V4_NODE_MODULES);
  const profiles = join(DSH_HOME, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) roots.push(join(profiles, name, 'node_modules'));
  }
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env: SHELL }).trim());
  } catch {
    /* npm unavailable — the other anchors may still hit */
  }
  for (const root of roots) {
    for (const rel of ['lib/index.js', 'dist/index.js']) {
      const file = join(root, CATALOG, rel);
      if (!existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href).catch(() => null);
      const factory = mod?.createSessionFormatCatalogWithChildren;
      if (typeof factory !== 'function') continue;
      const catalog = factory([]);
      if (catalog.currentVersion >= 4) return { root, catalog };
    }
  }
  return null;
}

/** Real session logs, newest first. */
function sessionLogs() {
  const sessions = join(DSH_HOME, 'sessions');
  if (!existsSync(sessions)) return [];
  const logs = [];
  for (const workspace of readdirSync(sessions)) {
    let ids;
    try {
      ids = readdirSync(join(sessions, workspace));
    } catch {
      continue; // a plain file where a workspace directory was expected
    }
    for (const id of ids) {
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        const file = join(sessions, workspace, id, name);
        if (!existsSync(file)) continue;
        try {
          logs.push({ file, mtime: statSync(file).mtimeMs });
        } catch {
          /* raced with a live session rotation */
        }
      }
    }
  }
  return logs.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_LOGS).map((l) => l.file);
}

const readRows = (file) =>
  execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], env: SHELL })
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/**
 * The messages the harness derives from a session log, in order — mirroring the
 * host's own deriveEventMessage(): `user/message` carries itself, the other
 * durable slots carry `.message`. `tool/result` is where the envelope changed.
 */
function derivedMessages(artifact) {
  const out = [];
  for (const event of artifact.events) {
    const data = event.data ?? {};
    if (event.type === 'user/message') out.push(data);
    else if (event.type === 'system/message' || event.type === 'developer/message'
      || event.type === 'assistant/message' || event.type === 'tool/result') {
      if (data.message) out.push(data.message);
    }
  }
  return out;
}

/** toolCallId -> tool name, from the assistant tool-call blocks (both envelopes share the id). */
function toolNames(messages) {
  const names = new Map();
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === 'tool-call') names.set(b.id, b.name);
  }
  return names;
}

/** The selected/custom text of one real `ask_user_question` answer, or null. */
function answerText(message, names) {
  const src = message?.source;
  if (src?.kind !== 'tool') return null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const wrapper = blocks.find((b) => b?.type === 'tool-result');
  const callId = src.callId ?? message.toolCallId
    ?? (wrapper ? wrapper.toolCallId : undefined);
  if (!callId || names.get(callId) !== 'ask_user_question') return null;
  if (wrapper ? wrapper.isError === true : message.isError === true) return null;
  const text = wrapper
    ? (wrapper.content ?? []).map((b) => (b?.type === 'text' ? b.text : '')).join(' ')
    : blocks.map((b) => (b?.type === 'text' ? b.text : '')).join(' ');
  try {
    const parsed = JSON.parse(text);
    const picked = [];
    for (const a of parsed?.answers ?? []) {
      if (Array.isArray(a.selected)) picked.push(...a.selected.filter((s) => typeof s === 'string'));
      if (typeof a.custom === 'string' && a.custom) picked.push(a.custom);
    }
    return picked.length > 0 ? picked.join(', ') : null;
  } catch {
    return null;
  }
}

/** The previous release's implementation, copied into the repo so its imports still resolve. */
async function loadPreFixClassifier() {
  const old = execFileSync('git', ['show', `${PREFIX_REF}:lib/classifier.js`], { cwd: REPO, encoding: 'utf8', env: SHELL });
  const dir = join(REPO, '.e2e-old-lib');
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(REPO, 'lib'), dir, { recursive: true });
  writeFileSync(join(dir, 'classifier.js'), old);
  const mod = await import(pathToFileURL(join(dir, 'classifier.js')).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const found = await findCurrentCatalog();
if (found === null) {
  skip(
    'no harness on session format >= 4 was found',
    'point DSH_V4_NODE_MODULES at a node_modules root that has it (e.g. the global DSH install), then rerun',
  );
} else {
  const { root, catalog } = found;
  console.log(`current-format harness: v${catalog.currentVersion} (${root})`);
  const current = await import(pathToFileURL(join(REPO, 'lib/classifier.js')).href);

  let pre = null;
  try {
    pre = await loadPreFixClassifier();
    console.log(`red control: ${PREFIX_REF}:lib/classifier.js`);
  } catch (error) {
    console.log(`red control unavailable (${error?.message ?? error}) — the green result alone proves less`);
  }

  const logs = sessionLogs();
  console.log(`scanning ${logs.length} real session log(s)…`);
  const cases = [];
  const skipped = [];
  try {
    for (const file of logs) {
      if (cases.length >= MAX_CASES) break;
      let artifact;
      try {
        const rows = readRows(file);
        const restore = catalog.createRestore(rows[0], { recovery: 'recoverable', validation: 'current' });
        for (const row of rows.slice(1)) restore.decodeRow(row);
        artifact = restore.finish();
      } catch (error) {
        skipped.push(`${file}: ${error?.message ?? error}`);
        continue;
      }
      const messages = derivedMessages(artifact);
      const names = toolNames(messages);
      for (let i = 0; i < messages.length && cases.length < MAX_CASES; i += 1) {
        const expected = answerText(messages[i], names);
        // Replay the history as it stood WHEN THAT ANSWER WAS THE LATEST THING —
        // the moment the gate next runs. A prefix that includes the answer is
        // what "the answer reached the window" means; the intent window is
        // deliberately bounded to recent messages, so older answers are out of
        // scope by design, not a failure.
        if (expected) cases.push({ file, version: artifact.header?.version ?? '?', messages: messages.slice(0, i + 1), expected });
      }
    }

    if (cases.length === 0) {
      skip(
        'no real log in this home contains an ask_user_question answer to replay',
        'this check needs real history; run it on a home where the tool was actually answered',
      );
    } else {
      let greenFailures = 0;
      let redHeld = 0;
      for (const c of cases) {
        // The message list handed to the classifier is the real derived history.
        const green = current.renderUserIntent(c.messages, 10);
        const greenOk = green.includes(c.expected);
        if (!greenOk) greenFailures += 1;
        const red = pre ? pre.mod.renderUserIntent(c.messages, 10) : null;
        const redSees = red === null ? null : red.includes(c.expected);
        if (redSees === false) redHeld += 1;
        console.log(
          `${greenOk ? '✓' : '✗'} v${c.version} ${c.file.includes('session.v3') ? 'legacy log' : 'current log'} — `
          + `green ${greenOk ? 'sees' : 'MISSES'} the answer`
          + (redSees === null ? '' : `, red control ${redSees ? 'also saw it (expected on legacy logs)' : 'did not'}`)
          + ` — ${JSON.stringify(c.expected).slice(0, 80)}`,
        );
      }
      console.log(`\nreplayed ${cases.length} real answer(s): green ${cases.length - greenFailures}/${cases.length}`
        + (pre ? `, red control failed to see ${redHeld}/${cases.length}` : ''));
      if (skipped.length > 0) console.log(`(${skipped.length} log(s) could not be restored — e.g. ${skipped[0].slice(0, 140)})`);
      if (greenFailures > 0) fail(`${greenFailures} real answer(s) did not reach the intent window`);
      else if (pre && redHeld === 0) console.log('NOTE: the red control saw every answer too — no case here exercises the v4 envelope');
      else console.log('PASS test:intent — real history reaches the intent window');
    }
  } finally {
    if (pre) pre.cleanup();
  }
}
