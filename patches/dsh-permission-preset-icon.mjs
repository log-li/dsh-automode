#!/usr/bin/env node
/**
 * Optional DSH patch — let the permission picker read a preset's `icon`.
 *
 * ## Why this is needed
 *
 * Stock DSH hardcodes the permission-picker glyphs in the client bundle, so a
 * host-configured preset like `auto-mode` renders the generic shield and its
 * `icon` field is silently ignored. This patch makes `icon` a real, portable
 * field on both halves:
 *
 *   - Host (`dsh-permission-presets`): the preset config schema and the client
 *     `PresetOption` projection accept an `icon` string (an SVG path `d`), and
 *     `optionOf()` passes it through.
 *   - Client (`dsh-client-ui-conversation`): a preset that declares an `icon`
 *     renders `shieldOutline` + that path; the built-in trio keep the hardcoded
 *     map as a fallback.
 *
 * ## Read this before running it
 *
 * - **It edits files inside `node_modules`.** That is invasive by nature, and it
 *   is why this script is shipped separately instead of running on install.
 * - **Every `npm update @deepseek-ai/dsh` / plugin reinstall wipes it.** Re-run
 *   this script afterwards. A mismatch is reported loudly rather than skipped.
 * - **It is cosmetic.** `auto-mode` behaves identically whether the bolt renders.
 *   If you do not care about the glyph, do not run this at all.
 * - Anchors are matched against the DSH 0.1.5 line. A future release that
 *   restructures the picker will make this fail with a message instead of
 *   corrupting anything — at that point the `icon` field is either supported
 *   natively (delete this script) or the anchors need updating.
 *
 * ## Usage
 *
 *   node patches/dsh-permission-preset-icon.mjs              # patch what it finds
 *   node patches/dsh-permission-preset-icon.mjs --dry-run    # report only
 *   node patches/dsh-permission-preset-icon.mjs --profile web  # one profile only
 *
 * Then restart `dsh web` (the host half is read at boot).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const only = (() => {
  const i = argv.indexOf('--profile')
  return i >= 0 ? argv[i + 1] : undefined
})()

const HOST_PKG = 'dsh-permission-presets'
const CLIENT_PKG = 'dsh-client-ui-conversation'

/**
 * Every `node_modules` directory that could hold the two `@deepseek-ai` packages.
 *
 * Deliberately **discovered, not hardcoded**: profiles have user-chosen names
 * (`web`, `tui`, …) and the global install root varies by package manager, so a
 * fixed path would only ever work on the author's machine.
 */
function nodeModulesRoots() {
  const roots = new Set()

  // 1) Every DSH profile.
  const profilesDir = join(HOME, '.dsh', 'profiles')
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      if (only !== undefined && name !== only) continue
      const nm = join(profilesDir, name, 'node_modules')
      if (existsSync(join(nm, '@deepseek-ai'))) roots.add(nm)
    }
  }

  // 2) The global install: `npm root -g`, plus the nested tree a globally
  //    installed `@deepseek-ai/dsh` keeps for its own dependencies.
  const globalRoots = []
  try {
    globalRoots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim())
  } catch {
    /* npm not on PATH — fall through to the conventional locations below */
  }
  globalRoots.push(join(HOME, '.npm-global', 'lib', 'node_modules'))
  globalRoots.push('/usr/local/lib/node_modules')
  globalRoots.push('/usr/lib/node_modules')

  for (const g of globalRoots) {
    if (g === '' || !existsSync(join(g, '@deepseek-ai'))) continue
    roots.add(g)
    const nested = join(g, '@deepseek-ai', 'dsh', 'node_modules')
    if (existsSync(join(nested, '@deepseek-ai'))) roots.add(nested)
  }

  return [...roots]
}

/** Every existing copy of `<pkg>/<rel>` across all discovered roots. */
function findTargets(pkg, rel) {
  const out = []
  for (const root of nodeModulesRoots()) {
    const file = join(root, '@deepseek-ai', pkg, rel)
    if (existsSync(file)) out.push(file)
  }
  return out
}

const HOST_MARKER = '...spec.icon !== void 0 ? { icon: spec.icon } : {}'
// 0.1.1-rc.2 bracket form / 0.1.2-rc.1 Map form — either indicates the client
// needs the optionGlyph insertion. We patch the first one found.
const CLIENT_BRACKET_FN =
  '\t\tfunction permissionGlyph(value) {\n\t\t\treturn permissionGlyphs[value];\n\t\t}'
const CLIENT_MAP_FN =
  '\t\tfunction permissionGlyph(value) {\n\t\t\treturn permissionGlyphs.get(value);\n\t\t}'

/**
 * Patch the host half: accept and forward `icon`.
 *
 * @returns {'patched' | 'already' | 'anchor-missing'} outcome.
 */
function patchHost(file) {
  let s = readFileSync(file, 'utf8')
  if (s.includes(HOST_MARKER)) return 'already'

  // 1. Config schema: presets accept `icon`. NOTE: the config schema uses
  // schemastery `z`, whose `Schema` has NO `.optional()` (only `.required()`/
  // `.default()`), and `z.object` fields are optional by default — so write
  // `icon: z.string()` (NOT `z.string().optional()`, which crashes on load).
  const cfgOld =
    'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\tname: z.string(),\n\t\t\tdescription: z.string()'
  const cfgNew =
    'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\tname: z.string(),\n\t\t\tdescription: z.string(),\n\t\t\ticon: z.string()'
  if (!s.includes(cfgOld)) return 'anchor-missing'
  s = s.replace(cfgOld, cfgNew)

  // 2. Client projection schema: PresetOption accepts `icon`.
  const optOld =
    'value: z$1.string().min(1),\n\t\t\t\tname: z$1.string().min(1),\n\t\t\t\tdescription: z$1.string().optional()'
  const optNew =
    'value: z$1.string().min(1),\n\t\t\t\tname: z$1.string().min(1),\n\t\t\t\tdescription: z$1.string().optional(),\n\t\t\t\ticon: z$1.string().optional()'
  if (!s.includes(optOld)) return 'anchor-missing'
  s = s.replace(optOld, optNew)

  // 3. optionOf(): pass the icon through.
  const ofOld = '...spec.description !== void 0 ? { description: spec.description } : {}'
  const ofNew =
    '...spec.description !== void 0 ? { description: spec.description } : {},\n\t\t\t...spec.icon !== void 0 ? { icon: spec.icon } : {}'
  if (!s.includes(ofOld)) return 'anchor-missing'
  s = s.replace(ofOld, ofNew)

  if (!DRY) writeFileSync(file, s)
  return 'patched'
}

const OPTION_GLYPH =
  '\t\t/** Glyph for an option, preferring a config-declared icon path over the built-in map. */\n' +
  '\t\tfunction optionGlyph(option) {\n' +
  '\t\t\tif (option != null && option.icon) {\n' +
  '\t\t\t\treturn (0, react_jsx_runtime.jsxs)("svg", {\n' +
  '\t\t\t\t\twidth: "16",\n' +
  '\t\t\t\t\theight: "16",\n' +
  '\t\t\t\t\tviewBox: "0 0 16 16",\n' +
  '\t\t\t\t\tfill: "none",\n' +
  '\t\t\t\t\t"aria-hidden": true,\n' +
  '\t\t\t\t\tchildren: [\n' +
  '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: shieldOutline, stroke: "currentColor", strokeWidth: "1.31831", strokeLinejoin: "round" }),\n' +
  '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: option.icon, fill: "currentColor" })\n' +
  '\t\t\t\t\t]\n' +
  '\t\t\t\t});\n' +
  '\t\t\t}\n' +
  '\t\t\treturn permissionGlyph(option != null ? option.value : "");\n' +
  '\t\t}'

/**
 * Patch the client half: render a declared `icon` inside the shield outline.
 *
 * @returns {'patched' | 'already' | 'anchor-missing'} outcome.
 */
function patchClient(file) {
  let s = readFileSync(file, 'utf8')
  if (s.includes('function optionGlyph(option)')) return 'already'

  // 1. Add optionGlyph() after permissionGlyph() — bracket (0.1.1-rc.2) or Map (0.1.2-rc.1).
  let fnOld = CLIENT_BRACKET_FN
  if (!s.includes(fnOld)) {
    fnOld = CLIENT_MAP_FN
    if (!s.includes(fnOld)) return 'anchor-missing'
  }
  s = s.replace(fnOld, fnOld + '\n' + OPTION_GLYPH)

  // 2. Dropdown: pass the whole option so option.icon is honored.
  if (!s.includes('const icon = permissionGlyph(option.value);')) return 'anchor-missing'
  s = s.replace('const icon = permissionGlyph(option.value);', 'const icon = optionGlyph(option);')

  // 3. Current-value trigger: use the resolved option (has icon).
  if (!s.includes('permissionGlyph(currentValue)')) return 'anchor-missing'
  s = s.split('permissionGlyph(currentValue)').join('optionGlyph(current)')

  if (!s.includes('function optionGlyph(option)')) return 'anchor-missing'
  if (!DRY) writeFileSync(file, s)
  return 'patched'
}

const LABEL = {
  patched: DRY ? 'would patch' : 'patched',
  already: 'already patched',
  'anchor-missing': 'ANCHORS NOT FOUND (skipped)',
}

console.log('dsh-permission-preset-icon' + (DRY ? ' (dry run)' : ''))
let touched = 0
let missing = 0
let found = 0

for (const [pkg, rel, fn] of [
  [HOST_PKG, join('lib', 'index.js'), patchHost],
  [CLIENT_PKG, join('lib', 'client.js'), patchClient],
]) {
  const targets = findTargets(pkg, rel)
  if (targets.length === 0) {
    console.log(`  ${pkg}: not found in any node_modules — skipped`)
    continue
  }
  for (const file of targets) {
    found++
    const outcome = fn(file)
    if (outcome === 'patched') touched++
    if (outcome === 'anchor-missing') missing++
    console.log(`  ${LABEL[outcome]}  ${file.replace(HOME, '~')}`)
  }
}

if (missing > 0) {
  console.log(
    `\n${missing} file(s) did not match this patch's anchors — DSH has probably changed.\n` +
      'Nothing was corrupted; those files were left untouched. Check whether the ' +
      'permission picker reads preset `icon`s natively now; if so, delete this script.',
  )
}
if (found === 0) {
  console.log('\nNothing to patch: neither @deepseek-ai package was installed for any profile.')
  process.exit(1)
}
console.log(
  touched === 0 && missing === 0
    ? '\nNothing to do — already applied.'
    : `\nDone${DRY ? ' (dry run, nothing written)' : ''}. Restart \`dsh web\` so the host half is reloaded.`,
)
