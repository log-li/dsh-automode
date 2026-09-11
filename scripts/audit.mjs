#!/usr/bin/env node
/**
 * Audit / retrospective tool for dsh-automode decision history (v0.14.0).
 *
 * Reads `~/.dsh/auto-mode/decisions.jsonl` and reports:
 *   - overall event distribution and per-day activity
 *   - approval-path (`decision` event) outcome mix
 *   - CONTRADICTION-PAIR SENTINEL: same session + tool, a `pre-execute-allow`
 *     followed within 60s by a `decision` outcome `rejected`. This exact pair
 *     was the signature of the v0.13.0 cache-signature-parity bug (17 pairs in
 *     the 08-22→09-11 history, all user-requested legitimate actions wrongly
 *     re-rejected) — with `--fail-on-pairs` the script exits non-zero when any
 *     exist, so a cron/CI run turns a regression into an alert.
 *   - fail-closed deny reasons grouped by {@link classifyFailureCategory}.
 *
 * Pure Node, no DSH runtime needed:
 *   node scripts/audit.mjs                 # report only (exit 0 unless read error)
 *   node scripts/audit.mjs --fail-on-pairs # exit 1 when contradiction pairs exist
 *   node scripts/audit.mjs --limit 200     # analyze only the last N records
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_PATH = join(homedir(), '.dsh', 'auto-mode', 'decisions.jsonl');
/** Window (ms) within which an allow followed by a rejected decision is a pair. */
export const PAIR_WINDOW_MS = 60_000;

function pt(s) {
  return new Date(s).getTime();
}

/** Load and parse the decisions log; malformed lines are skipped and counted. */
export function loadDecisions(path = LOG_PATH) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      rows.push(JSON.parse(l));
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/**
 * The v0.13.0 regression signature: a session where the pre-execute gate
 * allowed a call (pre-execute-allow) and the approval path then rejected the
 * same call (decision rejected) within {@link PAIR_WINDOW_MS}. Returns the
 * pairs as {allow, reject} record references, newest first.
 */
export function detectContradictionPairs(rows) {
  const allows = rows.filter((r) => r.event === 'pre-execute-allow');
  const rejects = rows.filter(
    (r) => r.event === 'decision' && r.outcome === 'rejected',
  );
  const pairs = [];
  for (const rej of rejects) {
    const t = pt(rej.at);
    const sid = rej.sessionId;
    const tool = rej.tool;
    const prior = allows.filter(
      (a) =>
        a.sessionId === sid &&
        a.tool === tool &&
        a.at !== undefined &&
        t - pt(a.at) >= 0 &&
        t - pt(a.at) <= PAIR_WINDOW_MS,
    );
    if (prior.length > 0) {
      const last = prior.reduce((x, y) => (pt(y.at) > pt(x.at) ? y : x));
      pairs.push({ allow: last, reject: rej });
    }
  }
  return pairs.sort((a, b) => pt(b.reject.at) - pt(a.reject.at));
}

/** Main report used by the CLI and exportable for tests. */
export function summarize(rows) {
  const dist = {};
  for (const r of rows) dist[r.event] = (dist[r.event] ?? 0) + 1;

  const outcomes = {};
  for (const r of rows.filter((x) => x.event === 'decision')) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  }

  const days = {};
  for (const r of rows) {
    const d = String(r.at ?? '').slice(0, 10);
    if (d) days[d] = (days[d] ?? 0) + 1;
  }

  return { total: rows.length, distribution: dist, outcomes, days };
}

export function formatSummary(s) {
  const lines = [
    `records: ${s.total}`,
    `events: ${Object.entries(s.distribution).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `approval outcomes: ${Object.entries(s.outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `active days: ${Object.keys(s.days).length}`,
  ];
  return lines.join('\n');
}

function main(argv) {
  const failOnPairs = argv.includes('--fail-on-pairs');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(argv[limitIdx + 1]) : undefined;

  let data;
  try {
    data = loadDecisions();
  } catch (e) {
    console.error(`audit: cannot read ${LOG_PATH}: ${e.message}`);
    process.exit(2);
  }
  let rows = data.rows;
  if (limit && limit > 0) rows = rows.slice(-limit);
  if (data.skipped > 0) console.error(`audit: skipped ${data.skipped} malformed line(s)`);

  console.log(formatSummary(summarize(rows)));

  const pairs = detectContradictionPairs(rows);
  if (pairs.length > 0) {
    console.log(`\n⚠ contradiction pairs (pre-execute-allow → decision rejected ≤60s): ${pairs.length}`);
    for (const { allow, reject } of pairs.slice(0, 20)) {
      const gapS = Math.round((pt(reject.at) - pt(allow.at)) / 1000);
      console.log(
        `  ${reject.at?.slice(0, 19)} ${reject.tool} → rejected ${gapS}s after allow: ${(allow.detail ?? '').slice(0, 60)}`,
      );
    }
    if (pairs.length > 20) console.log(`  … and ${pairs.length - 20} more`);
  } else {
    console.log('\ncontradiction pairs: 0 (no allow→reject regression signature)');
  }

  if (failOnPairs && pairs.length > 0) {
    console.error(`audit: FAIL — ${pairs.length} contradiction pair(s) detected (cache-signature regression?)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
