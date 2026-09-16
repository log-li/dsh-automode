/**
 * Extract one version's release notes from the bilingual CHANGELOG.
 *
 * The CHANGELOG is a single file with an English half on top and a Chinese half
 * below (`---` separator). Release notes must carry BOTH halves — a hand-rolled
 * "slice from this version to the next" extraction silently picks up only the
 * English one, which is exactly how the v0.15.3 release page ended up EN-only
 * (2026-09-16). This module is the single implementation: the release workflow
 * calls it, and so should any manual refresh.
 *
 *   node scripts/release-notes.mjs            # version from package.json
 *   node scripts/release-notes.mjs v0.15.3    # explicit
 */
import { readFileSync } from 'node:fs';

const ZH_MARKER = '\n# 更新日志';

/** @returns {string} notes for `version` (both halves), or a pointer if absent. */
export function extractReleaseNotes(changelog, version) {
  const ver = String(version).replace(/^v/, '');
  const idx = changelog.indexOf(ZH_MARKER);
  const en = idx === -1 ? changelog : changelog.slice(0, idx);
  const zh = idx === -1 ? '' : changelog.slice(idx);
  const escaped = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## \\[${escaped}\\][^\\n]*\\n[\\s\\S]*?(?=\\n## \\[|$)`);
  const grab = (block) => {
    const m = block.match(re);
    return m ? m[0].trim() : '';
  };
  const parts = [grab(en), grab(zh)].filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n---\n\n') : `Release v${ver} (see CHANGELOG.md)`;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  process.stdout.write(`${extractReleaseNotes(changelog, process.argv[2] ?? pkg.version)}\n`);
}
