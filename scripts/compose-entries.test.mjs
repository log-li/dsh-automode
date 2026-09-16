/**
 * Offline simulation of the DSH boot entry composition for the web profile.
 * Uses the same public functions the boot include calls, so the printed
 * entry list is exactly what mounts on restart. Opt-in: it needs a LOCAL DSH
 * install (`dsh-app-boot` is host-private and is not on the public registry),
 * so it is not part of `npm test`.
 *
 *   node scripts/compose-entries.test.mjs
 *
 * The anchor (the node_modules tree that holds `@deepseek-ai/dsh-app-boot`) is
 * **discovered, not hardcoded** — profiles have user-chosen names, and a path
 * baked in from one machine is dead weight everywhere else (the previous
 * revision shipped a Windows npx-cache path plus a stale entry name, so this
 * check had silently stopped passing). Override with:
 *
 *   DSH_ANCHOR_NODE_MODULES=/path/to/node_modules node scripts/compose-entries.test.mjs
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ANCHOR_PACKAGE = '@deepseek-ai/dsh-app-boot';
const EXPECTED_ENTRY = { id: 'auto-mode', name: '@log.li/dsh-automode' };

function discoverRoots() {
  const roots = [];
  if (process.env.DSH_ANCHOR_NODE_MODULES) roots.push(process.env.DSH_ANCHOR_NODE_MODULES);
  const profilesDir = join(homedir(), '.dsh', 'profiles');
  if (existsSync(profilesDir)) {
    roots.push(join(profilesDir, 'node_modules'));
    for (const profile of readdirSync(profilesDir)) {
      roots.push(join(profilesDir, profile, 'node_modules'));
    }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    if (globalRoot) roots.push(globalRoot);
  } catch {
    /* npm unavailable — the profile roots above are enough */
  }
  return [...new Set(roots)];
}

const anchorRoot = discoverRoots().find((root) => existsSync(join(root, ANCHOR_PACKAGE, 'package.json')));
if (!anchorRoot) {
  console.error(
    `SKIP: ${ANCHOR_PACKAGE} not found. Looked in:\n  ${discoverRoots().join('\n  ')}\n` +
      'Set DSH_ANCHOR_NODE_MODULES to the node_modules tree of a local DSH install to run this check.',
  );
  process.exit(0);
}

const anchor = `${anchorRoot}/@deepseek-ai/dsh/package.json`;

const { loadProfile, composeEntries } = await import(
  `file:///${anchorRoot}/${ANCHOR_PACKAGE}/lib/index.js`
);

const profile = loadProfile('dsh', 'web', anchor);
console.log('profile:', profile.name, '@', profile.dir);
console.log('layers:');
for (const layer of profile.layers) {
  console.log(`  ${layer.packageName}  →  ${layer.patchPath}`);
}

const entries = composeEntries([
  ...profile.layers.map((layer) => layer.patches),
  profile.patches,
]);
console.log('\ncomposed entries:');
for (const entry of entries) {
  console.log(
    `  id=${JSON.stringify(entry.id)} name=${JSON.stringify(entry.name)}` +
      (entry.disabled ? ' DISABLED' : ''),
  );
}

const autoMode = entries.find((entry) => entry.id === EXPECTED_ENTRY.id);
if (!autoMode) {
  console.error(`\nFAIL: ${EXPECTED_ENTRY.id} entry missing from composed entries`);
  process.exit(1);
}
if (autoMode.name !== EXPECTED_ENTRY.name) {
  console.error(
    `\nFAIL: ${EXPECTED_ENTRY.id} entry has wrong name ${JSON.stringify(autoMode.name)} ` +
      `(expected ${JSON.stringify(EXPECTED_ENTRY.name)})`,
  );
  process.exit(1);
}
console.log('\nPASS: auto-mode entry is composed and will mount on restart');

const permission = entries.find((entry) => entry.id === 'permission');
if (!permission) {
  console.error('\nFAIL: permission entry missing from composed entries');
  process.exit(1);
}
const autoPreset = permission.config?.presets?.['auto-mode'];
if (autoPreset?.approval !== 'ask') {
  console.error(
    `\nFAIL: auto-mode preset approval must stay the core-valid "ask", got ${JSON.stringify(autoPreset?.approval)}`,
  );
  process.exit(1);
}
if (autoPreset?.sandbox !== 'workspace-write') {
  console.error(
    `\nFAIL: auto-mode preset sandbox must be workspace-write, got ${JSON.stringify(autoPreset?.sandbox)}`,
  );
  process.exit(1);
}
console.log('\nPASS: auto-mode preset is declared with approval=ask and sandbox=workspace-write');
