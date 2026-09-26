#!/usr/bin/env node
/**
 * Optional DSH patch — let the permission picker read a preset's `icon`.
 *
 * ## Why this is needed
 *
 * Stock DSH hardcodes the permission-picker glyphs in the client bundle, so a
 * host-configured preset like `auto-mode` renders the generic shield (or no
 * glyph at all) and its `icon` field is silently ignored. This patch makes
 * `icon` a real field on both halves of the DSH 0.1.7-rc.2 line:
 *
 *   - Host (`dsh-permission-presets`): the preset config schema accepts an
 *     `icon` string, and `optionOf()` passes it through to the catalog.
 *   - Client (`dsh-client-ui-permission-presets`): an option that declares an
 *     `icon` renders that SVG path inside the design set's shield outline; the
 *     built-in trio keep their hardcoded glyph map as the fallback.
 *
 * No wire change is needed: `permissionPresets.catalog` crosses the typert
 * boundary with a result codec that declares neither `encode` nor `decode`, so
 * the extra field rides through untouched on both sides.
 *
 * ## Read this before running it
 *
 * - **It edits files inside `node_modules`.** That is invasive by nature, and it
 *   is why this script is shipped separately instead of running on install.
 * - **Every `npm update @deepseek-ai/dsh` / plugin reinstall wipes it.** Re-run
 *   this script afterwards. A mismatch is reported loudly rather than skipped
 *   silently.
 * - **It is cosmetic.** `auto-mode` behaves identically whether the bolt
 *   renders. If you do not care about the glyph, do not run this at all.
 * - **Anchors are matched against the DSH 0.1.7-rc.2 line.** Earlier 0.1.x lines
 *   are skipped with a note (their picker lives in a different package, so the
 *   anchors can never match) and exit 0; any other release — a newer one, or one
 *   whose layout this script cannot read — is left byte-identical and reported
 *   with the anchor that missed. At that point the `icon` field is either
 *   supported natively (delete this script) or the anchors need updating.
 *
 * ## Usage
 *
 *   node patches/dsh-permission-preset-icon.mjs                  # patch what it finds
 *   node patches/dsh-permission-preset-icon.mjs --dry-run        # report only
 *   node patches/dsh-permission-preset-icon.mjs --profile web    # one profile only
 *
 * Exit status: `0` = everything matched (patched, already patched, or nothing of
 * this generation installed), `1` = at least one anchor missed and that file was
 * left untouched, `2` = bad usage. Each rewritten file keeps a pristine copy at
 * `<file>.pre-dsh-automode-icon.bak`.
 *
 * Then restart `dsh web` (the host half is read at boot; the client half is
 * re-read on a page reload).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')

const usageError = (message) => {
  console.error(`dsh-permission-preset-icon: ${message}`)
  console.error('usage: dsh-permission-preset-icon.mjs [--dry-run] [--profile <name>]')
  process.exit(2)
}

const profileFlag = argv.find((arg) => arg === '--profile' || arg.startsWith('--profile='))
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--dry-run') continue
  if (arg === '--profile') {
    i++ // its value is consumed here; validate it below
    continue
  }
  if (arg.startsWith('--profile=')) continue
  usageError(`unknown argument ${JSON.stringify(arg)}`)
}
if (profileFlag !== undefined && profileFlag.startsWith('--profile=') && profileFlag.length === '--profile='.length) {
  usageError('--profile needs a profile name')
}
const only =
  profileFlag === undefined
    ? undefined
    : profileFlag === '--profile'
      ? argv[argv.indexOf(profileFlag) + 1]
      : profileFlag.slice('--profile='.length)
if (profileFlag !== undefined && (only === undefined || only === '' || only.startsWith('--'))) {
  usageError('--profile needs a profile name (e.g. --profile web)')
}

const HOST_PKG = 'dsh-permission-presets'
const CLIENT_PKG = 'dsh-client-ui-permission-presets'
const BACKUP_SUFFIX = '.pre-dsh-automode-icon.bak'

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

/**
 * Every existing copy of `<pkg>/<rel>` across all discovered roots, as
 * `{ file, via }`.
 *
 * Deduplicated **by realpath, and the realpath is what gets patched**: a profile
 * may reach the artifact through a symlinked entry (this machine does:
 * `profiles/peakrate-test/node_modules/@deepseek-ai → profiles/web/node_modules/@deepseek-ai`),
 * and patching — or backing up — one file twice would be wrong. `via` records the
 * discovered path when it resolves somewhere else, so the report says *which*
 * profile the file belongs to instead of implying a profile that does not own it.
 */
function findTargets(pkg, rel) {
  const out = new Map()
  for (const root of nodeModulesRoots()) {
    const file = join(root, '@deepseek-ai', pkg, rel)
    if (!existsSync(file)) continue
    // Resolve the ROOT first: that absorbs platform aliases (`/tmp` →
    // `/private/tmp`) without inventing a symlink note, and still exposes a
    // profile whose tree is genuinely reached through a link.
    const resolved = (() => {
      try {
        return join(realpathSync(root), '@deepseek-ai', pkg, rel)
      } catch {
        return file
      }
    })()
    let real = file
    try {
      real = realpathSync(file)
    } catch {
      /* keep the literal path when the realpath cannot be resolved */
    }
    const seen = out.get(real)
    if (seen === undefined) out.set(real, { file: real, via: resolved === real ? undefined : resolved })
    else if (seen.via === undefined && resolved !== real) seen.via = resolved
  }
  return [...out.values()]
}

/** `~`-shorten a path that may be reached through `/tmp → /private/tmp`. */
function pretty(file) {
  const home = (() => {
    try {
      return realpathSync(HOME)
    } catch {
      return HOME
    }
  })()
  const short = (base) => (file === base ? '~' : file.startsWith(`${base}/`) ? `~${file.slice(base.length)}` : undefined)
  return short(home) ?? short(HOME) ?? file
}

/** Read the installed package version of a `lib/<file>` target. */
function versionOf(file) {
  try {
    const manifest = join(dirname(dirname(file)), 'package.json')
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch {
    return '?'
  }
}

/**
 * Compare an installed version with the 0.1.7 line these anchors describe.
 *
 * `-1` = an older generation (its picker lives in a different package and its
 * schema has different indentation, so the anchors can never match — skipping it
 * quietly keeps `apply-dsh-patches.sh` output honest); `0` = the targeted line;
 * `1` = newer or unparseable, so the anchors still get their chance and a miss is
 * reported loudly.
 */
function lineOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (m === null) return 1
  const asNumber = (major, minor, patch) => Number(major) * 1e6 + Number(minor) * 1e3 + Number(patch)
  return Math.sign(asNumber(m[1], m[2], m[3]) - asNumber(0, 1, 7))
}

/** Count non-overlapping occurrences of `needle`. */
function countOf(haystack, needle) {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

/**
 * Apply one file's edits, all or nothing.
 *
 * Every anchor is checked against the *current* text first; a single miss means
 * the file is reported and left byte-identical, so a partially patched bundle
 * can never be left behind.
 *
 * @param file - absolute path to the built artifact.
 * @param edits - ordered `{ name, find, replace, expect }` edits.
 * @param marker - text that identifies this patch's output.
 * @param legacy - text that identifies an older/foreign injection to refuse.
 * @returns `{ outcome, detail }` with outcome one of `patched` / `would-patch` /
 * `already` / `anchor-missing` / `legacy`.
 */
function patchFile(file, edits, marker, legacy) {
  let source = readFileSync(file, 'utf8')

  if (source.includes(marker)) return { outcome: 'already' }
  if (legacy !== undefined) {
    const hit = legacy.patterns.find((pattern) => source.includes(pattern))
    if (hit !== undefined) return { outcome: 'legacy', detail: legacy.detail }
  }

  const missing = []
  for (const edit of edits) {
    const seen = countOf(source, edit.find)
    if (seen !== edit.expect) {
      missing.push(`${edit.name} — anchor ×${seen}, expected ×${edit.expect}`)
      continue
    }
    source = source.split(edit.find).join(edit.replace)
  }
  if (missing.length > 0) return { outcome: 'anchor-missing', detail: missing }

  if (!DRY) {
    writeFileSync(`${file}${BACKUP_SUFFIX}`, readFileSync(file))
    writeFileSync(file, source)
  }
  return { outcome: DRY ? 'would-patch' : 'patched' }
}

// ---------------------------------------------------------------------------
// Host half — the preset schema accepts `icon`, `optionOf()` forwards it.
// ---------------------------------------------------------------------------

const HOST_MARKER = '...spec.icon !== void 0 ? { icon: spec.icon } : {}'
const HOST_EDITS = [
  {
    name: 'preset config schema (icon: z.string())',
    // NOTE: the config schema is schemastery, whose `Schema` has NO
    // `.optional()` (only `.required()`/`.default()`); `z.object` fields are
    // optional by default — so `icon: z.string()` is the correct spelling and
    // `.optional()` would throw at module load.
    find: 'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\t\tname: z.string(),\n\t\t\t\tdescription: z.string()',
    replace:
      'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\t\tname: z.string(),\n\t\t\t\tdescription: z.string(),\n\t\t\t\ticon: z.string()',
    expect: 1,
  },
  {
    name: 'optionOf() icon passthrough',
    find: '...spec.description !== void 0 ? { description: spec.description } : {}',
    replace:
      '...spec.description !== void 0 ? { description: spec.description } : {},\n\t\t\t...spec.icon !== void 0 ? { icon: spec.icon } : {}',
    expect: 1,
  },
]

// ---------------------------------------------------------------------------
// Client half — render a declared `icon` path inside the shield outline.
// ---------------------------------------------------------------------------

/**
 * The design set's shield outline, copied as a literal from the read-only /
 * full-access permission icons of `@deepseek-ai/dsh-client-ui-primitives`
 * (16×16 viewBox, `stroke: currentColor`, `stroke-linejoin: round`, 1-unit
 * stroke — exactly what the built-in glyphs draw). A literal keeps this patch
 * independent of private symbols: the previous generation referenced
 * `shieldOutline`, which the current primitives no longer export.
 */
const SHIELD_OUTLINE =
  'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z'

const CLIENT_MARKER = 'dsh-automode: icon patch'

const OPTION_GLYPH = [
  '',
  `\t\t/* ${CLIENT_MARKER} — a host-declared \`icon\` (an SVG path \`d\`) drawn inside the shield outline. */`,
  '\t\tfunction optionGlyph(option) {',
  '\t\t\tconst icon = option != null ? option.icon : void 0;',
  '\t\t\tif (typeof icon === "string" && icon !== "") {',
  '\t\t\t\treturn (0, react_jsx_runtime.jsxs)("svg", {',
  '\t\t\t\t\twidth: "16",',
  '\t\t\t\t\theight: "16",',
  '\t\t\t\t\tviewBox: "0 0 16 16",',
  '\t\t\t\t\tfill: "none",',
  '\t\t\t\t\tstrokeWidth: "1",',
  '\t\t\t\t\t"aria-hidden": true,',
  '\t\t\t\t\tchildren: [',
  `\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: "${SHIELD_OUTLINE}", stroke: "currentColor", strokeLinejoin: "round" }),`,
  '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("path", { d: icon, fill: "currentColor", stroke: "none" })',
  '\t\t\t\t\t]',
  '\t\t\t\t});',
  '\t\t\t}',
  '\t\t\treturn permissionGlyph(option != null ? option.value : "");',
  '\t\t}',
].join('\n')

const CLIENT_EDITS = [
  {
    name: 'optionGlyph() helper',
    find: '\t\tfunction permissionGlyph(value) {\n\t\t\treturn permissionGlyphs.get(value);\n\t\t}\n',
    replace: '\t\tfunction permissionGlyph(value) {\n\t\t\treturn permissionGlyphs.get(value);\n\t\t}\n' + OPTION_GLYPH + '\n',
    expect: 1,
  },
  {
    name: 'dropdown item glyph',
    find: 'const icon = permissionGlyph(option.value);',
    replace: 'const icon = optionGlyph(option);',
    expect: 1,
  },
  {
    name: 'current-value trigger glyph',
    find: 'permissionGlyph(currentValue)',
    replace: 'optionGlyph(current)',
    expect: 2,
  },
]

const CLIENT_LEGACY = {
  patterns: ['shieldOutline', 'function optionGlyph('],
  detail:
    'another injection is already present (a `shieldOutline` reference, which the current primitives no longer export, ' +
    'or an unrecognized `optionGlyph`); reinstall the package (npm install) so the file is pristine, then re-run',
}

const LABEL = {
  patched: 'patched',
  'would-patch': 'would patch',
  already: 'already patched',
  'anchor-missing': 'ANCHORS NOT FOUND (left untouched)',
  legacy: 'REFUSED (left untouched)',
  older: 'skipped (older DSH line)',
}

/** Run the whole patch and return the process exit code. */
function main() {
  console.log('dsh-permission-preset-icon' + (DRY ? ' (dry run)' : ''))
  let touched = 0
  let missing = 0
  let found = 0
  let older = 0

  for (const [pkg, rel, edits, marker, legacy] of [
    [HOST_PKG, join('lib', 'index.js'), HOST_EDITS, HOST_MARKER, undefined],
    [CLIENT_PKG, join('lib', 'client.js'), CLIENT_EDITS, CLIENT_MARKER, CLIENT_LEGACY],
  ]) {
    const targets = findTargets(pkg, rel)
    if (targets.length === 0) {
      console.log(`  ${pkg}: not found in any node_modules — skipped`)
      continue
    }
    for (const { file, via } of targets) {
      const version = versionOf(file)
      const where = `  ${pretty(file)}  (@deepseek-ai/${pkg} ${version})`
      const through = via === undefined ? '' : `\n      - reached through ${pretty(via)} (symlinked entry)`
      if (lineOf(version) < 0) {
        older++
        console.log(`${LABEL.older}${where}`)
        continue
      }
      found++
      const { outcome, detail } = patchFile(file, edits, marker, legacy)
      if (outcome === 'patched' || outcome === 'would-patch') touched++
      if (outcome === 'anchor-missing' || outcome === 'legacy') missing++
      console.log(`${LABEL[outcome]}${where}${through}`)
      if (outcome === 'legacy') console.log(`      - ${detail}`)
      else for (const line of detail ?? []) console.log(`      - ${line}`)
    }
  }

  if (missing > 0) {
    console.log(
      `\n${missing} file(s) did not match this patch's anchors — either DSH moved off the 0.1.7-rc.2 line or the file\n` +
        'was already modified by something else. Nothing was corrupted: those files were left byte-identical.\n' +
        'Check whether the permission picker reads preset `icon`s natively now; if it does, delete this script.',
    )
  }
  if (found === 0) {
    if (older > 0) {
      console.log('\nNothing to do — only older DSH lines are installed (this patch targets 0.1.7-rc.2 and later).')
      return 0
    }
    console.log('\nNothing to patch: neither @deepseek-ai package was installed for any profile.')
    return 1
  }
  console.log(
    touched === 0 && missing === 0
      ? '\nNothing to do — already applied.'
      : `\nDone${DRY ? ' (dry run, nothing written)' : ''}. Restart \`dsh web\` so the host half is reloaded; reload the page for the client half.`,
  )
  return missing > 0 ? 1 : 0
}

// `exitCode` (not `process.exit`) so a piped stdout still flushes completely.
process.exitCode = main()
