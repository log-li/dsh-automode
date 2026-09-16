/**
 * Privacy gate — run BEFORE a commit exists, not after.
 *
 * Why pre-commit: git history is append-only. A string that reaches a commit
 * stays visible in that commit forever; a later "sanitize" commit only adds a
 * new tree — it cannot remove what the old commits already publish (2026-09-16,
 * dsh-automode: `/Users/<user>/…` sat in 8 commits of a public repo, and the
 * sanitizing commit `a75a7f3` did not undo any of them).
 *
 * So this gate fails the commit if any tracked / staged file contains this
 * machine's identity:
 *   - the absolute home directory (`/Users/<user>`, `/home/<user>`, …)
 *   - the username on its own
 *   - the hostname
 *
 * Usage:
 *   node scripts/privacy-check.mjs            # every tracked file (gate for CI / npm test)
 *   node scripts/privacy-check.mjs --staged   # only what is staged (pre-commit hook)
 *
 * Enable the hook once per clone:  git config core.hooksPath .githooks
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';

/** Literal strings that must not appear in repo text. */
export function needles({ home = homedir(), user = userInfo().username, host = hostname() } = {}) {
  const out = new Set();
  if (home) {
    out.add(home);
    out.add(home.replace(/\/+$/, ''));
  }
  if (user && user.length > 2) {
    out.add(`/Users/${user}`);
    out.add(`/home/${user}`);
    out.add(`C:\\Users\\${user}`);
  }
  if (host && host.length > 3) out.add(host);
  return [...out].filter((n) => n.length > 3);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/**
 * @returns {Array<{file: string, line: number, needle: string, text: string}>}
 */
export function scan(files, opts = {}) {
  const pats = needles(opts);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable / binary / deleted
    }
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split('\n');
    for (const needle of pats) {
      if (!text.includes(needle)) continue;
      lines.forEach((line, i) => {
        if (line.includes(needle)) hits.push({ file, line: i + 1, needle, text: line.trim().slice(0, 160) });
      });
    }
  }
  return hits;
}

/** File list for the mode: staged only, or every tracked file. */
export function targetFiles(stagedOnly) {
  const out = stagedOnly
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : git(['ls-files']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const stagedOnly = process.argv.includes('--staged');
  const files = targetFiles(stagedOnly);
  const hits = scan(files);
  if (hits.length > 0) {
    console.error(
      `\n✖ privacy gate: ${hits.length} local-identity leak(s) in ${stagedOnly ? 'staged' : 'tracked'} files.\n` +
        '  These would be published in the commit and CANNOT be undone by a later commit.\n',
    );
    for (const h of hits.slice(0, 20)) console.error(`  ${h.file}:${h.line}  [${h.needle}]\n    ${h.text}`);
    if (hits.length > 20) console.error(`  … and ${hits.length - 20} more`);
    console.error('\n  Fix: write `~` / `/Users/<user>` / placeholders instead of this machine’s real paths.\n');
    process.exit(1);
  }
  console.log(`✓ privacy gate: no local identity in ${files.length} ${stagedOnly ? 'staged' : 'tracked'} file(s)`);
}
