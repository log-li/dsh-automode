/**
 * Opt-in E2E: does REAL session history survive the CURRENT session format, and
 * do this plugin's injected messages keep the identity we now write? (v0.15.4)
 *
 * Why this exists: `dsh >= 0.1.7-alpha.1` (session format v4) refuses the retired
 * catch-all `{ kind: 'plugin', plugin: '…' }` message source on every durable
 * slot, so the fix changed the injected source kind to `plugin:auto-mode`. Two
 * questions can only be answered against real data:
 *   1. do sessions written BEFORE the fix still reopen on the new format, and
 *      does the migration map their injection records onto the kind we write now?
 *   2. is the retired shape really refused (red control) and our shape accepted?
 *
 * It needs an installed NEW-format harness (the local DSH profile may be older)
 * plus real v3 session logs, so it is opt-in and SKIPs with guidance instead of
 * failing, exactly like `npm run test:compose`.
 *
 *   DSH_V4_NODE_MODULES=/tmp/dsh-v4-cli/node_modules npm run test:v4
 *
 * Anchors (first hit wins):
 *   - $DSH_V4_NODE_MODULES                    explicit node_modules root
 *   - $DSH_HOME/profiles/<name>/node_modules  any profile already on format v4
 *   - $(npm root -g)                          a globally installed v4 harness
 *
 * A SKIP means "nothing was verified" and must never look like a pass: when the
 * environment IS there but the controls cannot be exercised, this exits non-zero
 * (independent-review findings F1/F2 — silence used to print PASS).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CATALOG = '@deepseek-ai/dsh-session-format-catalog';
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const RETIRED = { kind: 'plugin', plugin: 'auto-mode' };
const FIXED = { kind: 'plugin:auto-mode' };

const skip = (why, how) => {
  console.log(`SKIP test:v4 — ${why}`);
  if (how) console.log(`  ${how}`);
  process.exitCode = 0;
};

const fail = (...lines) => {
  console.log(`FAIL test:v4 — ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`  ${line}`);
  process.exitCode = 1;
};

// Evaluated once: `npm root -g` spawns a process.
const candidateRoots = (() => {
  const roots = [];
  if (process.env.DSH_V4_NODE_MODULES) roots.push(process.env.DSH_V4_NODE_MODULES);
  const profiles = join(DSH_HOME, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) roots.push(join(profiles, name, 'node_modules'));
  }
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch {
    /* npm unavailable — the other anchors may still hit */
  }
  return roots;
})();

/** Locate a catalog whose current format is >= v4 (never silently accept an older one). */
async function findCurrentCatalog() {
  const tried = [];
  for (const root of candidateRoots) {
    const entry = join(root, CATALOG);
    if (!existsSync(join(entry, 'package.json'))) continue;
    for (const rel of ['lib/index.js', 'dist/index.js']) {
      const file = join(entry, rel);
      if (!existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href).catch((error) => {
        tried.push(`${file}: ${error?.message ?? error}`);
        return null;
      });
      const factory = mod?.createSessionFormatCatalogWithChildren;
      if (typeof factory !== 'function') continue;
      const catalog = factory([]);
      if (catalog.currentVersion >= 4) return { root, catalog };
    }
  }
  return tried.length > 0 ? { root: candidateRoots[0], error: tried.join(' | ') } : null;
}

/** Real session logs on disk. */
function sessionLogs() {
  const sessions = join(DSH_HOME, 'sessions');
  if (!existsSync(sessions)) return [];
  const logs = [];
  for (const workspace of readdirSync(sessions)) {
    const dir = join(sessions, workspace);
    let ids;
    try {
      ids = readdirSync(dir);
    } catch {
      continue; // a plain file where a workspace directory was expected
    }
    for (const id of ids) {
      const file = join(dir, id, 'session.v3.jsonl.zstd');
      if (existsSync(file)) logs.push(file);
    }
  }
  return logs;
}

const readRows = (file) => {
  const raw = file.endsWith('.zstd')
    // stderr is captured, not inherited: one broken reader must not spam one line per log
    ? execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
    : readFileSync(file, 'utf8');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
};

const restore = (catalog, rows) => {
  const r = catalog.createRestore(rows[0], { recovery: 'recoverable', validation: 'current' });
  for (const row of rows.slice(1)) r.decodeRow(row);
  return r.finish();
};

/** Every message a durable event slot carries (`user/message` carries itself). */
function messagesOf(event) {
  const data = event.data ?? {};
  if (event.type === 'user/message') return [data];
  if (data.message) return [data.message];
  if (Array.isArray(data.inserted)) return data.inserted;
  if (Array.isArray(data.messages)) return data.messages;
  return [];
}

const isOurs = (source) =>
  Boolean(source) && (source.plugin === 'auto-mode' || source.kind === 'plugin:auto-mode');

/** This plugin's injected messages, wherever they sit in a durable slot. */
function injected(artifact) {
  const found = [];
  for (const event of artifact.events) {
    for (const message of messagesOf(event)) {
      if (isOurs(message?.source)) found.push({ seq: event.seq, type: event.type, source: message.source });
    }
  }
  return found;
}

/**
 * Re-encode the artifact as CURRENT rows with every injected source rewritten.
 * Messages are copied, never mutated in place, so the caller's artifact stays
 * valid for the next control (review finding F3).
 */
function encodeAs(catalog, artifact, rewrite) {
  const events = artifact.events.map((event) => {
    const data = { ...(event.data ?? {}) };
    const source = { ...rewrite };
    if (event.type === 'user/message') {
      if (isOurs(data.source)) data.source = source;
    } else if (isOurs(data.message?.source)) {
      data.message = { ...data.message, source };
    } else if (Array.isArray(data.inserted)) {
      data.inserted = data.inserted.map((m) => (isOurs(m?.source) ? { ...m, source } : m));
    } else if (Array.isArray(data.messages)) {
      data.messages = data.messages.map((m) => (isOurs(m?.source) ? { ...m, source } : m));
    }
    return { ...event, data };
  });
  return [catalog.encodeCurrentHeader(artifact.header, 0), ...events.map((event) => catalog.encodeCurrentEvent(event))];
}

const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: `${error.constructor.name}: ${error.message}` };
  }
};

const found = await findCurrentCatalog();
if (found === null) {
  skip(
    `no harness on session format >= 4 was found (looked in ${candidateRoots.length} node_modules roots)`,
    'install one into an isolated home — e.g. `npm install --prefix /tmp/dsh-v4-cli @deepseek-ai/dsh@alpha` — ' +
      'then rerun with DSH_V4_NODE_MODULES=/tmp/dsh-v4-cli/node_modules',
  );
} else if (found.error) {
  fail('a harness was found but its catalogue could not be imported', found.error);
} else {
  const { root, catalog } = found;
  console.log(`current-format harness: v${catalog.currentVersion} (${root})`);

  const logs = sessionLogs();
  if (logs.length === 0) {
    skip(`no session logs under ${join(DSH_HOME, 'sessions')}`, 'this check needs real history to migrate');
  } else {
    const started = Date.now();
    let migrated = 0;
    let notReopened = 0;
    let injectionRecords = 0;
    let wrongKind = 0;
    let redRefusals = 0;
    let redMissed = 0;
    let greenRefused = 0;
    let greenKindLost = 0;
    const readFailures = [];

    for (const file of logs) {
      const parsed = attempt(() => readRows(file));
      if (!parsed.ok) {
        readFailures.push(`${file}: ${parsed.error}`);
        continue;
      }
      const rows = parsed.value;
      if (rows[0]?.version !== 3) continue; // already-current logs go through the host itself

      const restored = attempt(() => restore(catalog, rows));
      if (!restored.ok) {
        notReopened += 1;
        console.log(`✗ ${file}: real history does NOT reopen on v${catalog.currentVersion} — ${restored.error}`);
        continue;
      }
      migrated += 1;
      const artifact = restored.value;

      const hits = injected(artifact);
      injectionRecords += hits.length;
      const wrong = hits.filter((hit) => hit.source.kind !== FIXED.kind);
      if (wrong.length > 0) {
        wrongKind += wrong.length;
        console.log(`✗ ${file}: ${wrong.length} injection record(s) did not converge on ${FIXED.kind}`);
      }
      if (hits.length === 0) continue;

      // Red control: the retired shape must not survive a write/read round trip.
      const encoded = attempt(() => encodeAs(catalog, artifact, RETIRED));
      if (!encoded.ok) {
        redRefusals += 1; // refused while writing the row — this is what a live v4 host does
      } else {
        const decoded = attempt(() => restore(catalog, encoded.value));
        if (decoded.ok) {
          redMissed += 1;
          console.log(`✗ ${file}: RED CONTROL DID NOT FIRE — the retired source shape survived v${catalog.currentVersion}`);
        } else {
          redRefusals += 1; // refused while reading the row back
        }
      }

      // Green control: our shape must be accepted AND still carry our kind.
      const green = attempt(() => restore(catalog, encodeAs(catalog, artifact, FIXED)));
      if (!green.ok) {
        greenRefused += 1;
        console.log(`✗ ${file}: the fixed source shape was REFUSED — ${green.error}`);
      } else if (injected(green.value).some((hit) => hit.source.kind !== FIXED.kind)) {
        greenKindLost += 1;
        console.log(`✗ ${file}: accepted our shape but restored it without ${FIXED.kind}`);
      }
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const summary =
      `${migrated} migrated · ${injectionRecords} injection record(s) · ` +
      `${redRefusals} red refusal(s) · ${greenRefused + greenKindLost === 0 ? 'green ok' : 'green failed'} · ${seconds}s`;

    if (readFailures.length === logs.length) {
      fail(`every session log failed to read (${logs.length})`, readFailures[0]);
    } else if (migrated === 0) {
      fail(`no format-v3 session log could be migrated (${logs.length} candidate log(s))`, summary);
    } else if (injectionRecords === 0) {
      // Nothing to rewrite ⇒ the red/green controls never ran. A pass here would
      // be the exact false green this script exists to prevent.
      fail(
        `the red/green source-kind controls could NOT be exercised: ${migrated} log(s) migrated, but none carried an auto-mode injection record`,
        summary,
        'point DSH_HOME at a history that contains an auto-mode injection (or let the plugin deny one call first), then rerun',
      );
    } else {
      if (readFailures.length > 0) {
        console.log(`note: ${readFailures.length}/${logs.length} log(s) could not be read and were skipped — first: ${readFailures[0]}`);
      }
      const failures = notReopened + wrongKind + redMissed + greenRefused + greenKindLost;
      if (failures > 0) fail(`${failures} problem(s)`, summary);
      else console.log(`PASS test:v4 — ${summary}`);
    }
  }
}
