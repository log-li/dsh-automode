#!/usr/bin/env node
/**
 * Self-test for `patches/dsh-permission-preset-icon.mjs`.
 *
 * The patch edits built DSH artifacts inside `node_modules`, so the tests run it
 * as a child process against a **synthetic** `HOME` whose profile tree carries
 * exactly the anchors of the DSH 0.1.7-rc.2 line — hermetic, no real install is
 * touched, and the fixtures double as the written-down anchor contract.
 *
 * A final adaptive check dry-runs the script against the **real** `HOME`: it
 * asserts the anchors still match when a 0.1.7-rc.2 target exists, and reports
 * SKIP (never fails) on a machine with other DSH lines installed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PATCH = join(ROOT, 'patches', 'dsh-permission-preset-icon.mjs')

const HOST_PKG = 'dsh-permission-presets'
const CLIENT_PKG = 'dsh-client-ui-permission-presets'
const BACKUP_SUFFIX = '.pre-dsh-automode-icon.bak'
/** Marker the patch leaves in a patched client bundle. */
const CLIENT_MARKER_TEXT = 'dsh-automode: icon patch'

/** Minimal stand-in for `dsh-permission-presets/lib/index.js` (0.1.7-rc.2 shape). */
const HOST_PRISTINE = `import z from "@deepseek-ai/schemastery";
class PermissionPresetService {
	static Config = z.object({
		presets: z.dict(z.object({
					sandbox: z.union(SANDBOX_MODES).required(),
				approval: z.union(APPROVAL_POLICIES).required(),
				name: z.string(),
				description: z.string()
		})).default({}),
		defaultPreset: z.string().volatile()
	});
	optionOf(name) {
		const spec = this.resolve(name);
		return {
			value: name,
			name: spec.name ?? name,
			...spec.description !== void 0 ? { description: spec.description } : {}
		};
	}
}
export { PermissionPresetService };
`

/** Minimal stand-in for `dsh-client-ui-permission-presets/lib/client.js` (0.1.7-rc.2 shape). */
const CLIENT_PRISTINE = `window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-permission-presets",
	factory: (require) => {
		const permissionGlyphs = new Map([["read-only", readOnlyGlyph]]);
		function permissionGlyph(value) {
			return permissionGlyphs.get(value);
		}
		function PermissionSelect({ catalog, selection }) {
			const currentValue = selection.currentValue;
			const current = catalog.options.find((option) => option.value === currentValue);
			const items = catalog.options.map((option) => {
				const icon = permissionGlyph(option.value);
				return {
					id: option.value,
					...icon === void 0 ? {} : { icon }
				};
			});
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				permissionGlyph(currentValue) !== void 0 && (0, react_jsx_runtime.jsx)("span", {
					className: PermissionSelect_module_css_default.triggerIcon,
					"aria-hidden": true,
					children: permissionGlyph(currentValue)
				}),
				items
			] });
		}
		return { PermissionSelect };
	}
});
`

const results = []
const homes = []
const record = (name, ok, detail) => {
	results.push({ name, ok, detail })
	console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** One synthetic `HOME` with `~/.dsh/profiles/<name>/node_modules/@deepseek-ai/**`. */
function makeHome(spec) {
	const home = mkdtempSync(join(tmpdir(), 'dsh-icon-patch-test-'))
	homes.push(home)
	for (const [profile, files] of Object.entries(spec)) {
		for (const [pkg, { file, version, content }] of Object.entries(files)) {
			const dir = join(home, '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', pkg)
			mkdirSync(dirname(join(dir, file)), { recursive: true })
			// `type: module` mirrors both real packages, so `node --check` on the
			// patched artifact parses it the way the runtime would.
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${pkg}`, version, type: 'module' }))
			writeFileSync(join(dir, file), content)
		}
	}
	return home
}

/** Parse a patched artifact exactly as Node would load it. */
function nodeCheck(file) {
	const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
	return { ok: result.status === 0, detail: (result.stderr ?? '').split('\n').slice(0, 3).join(' ') }
}

function run(home, args = []) {
	// A deliberately unusable PATH keeps the script's `npm root -g` probe from
	// finding this machine's global install: the synthetic HOME stays the only
	// discoverable root.
	const result = spawnSync(process.execPath, [PATCH, ...args], {
		env: { ...process.env, HOME: home, PATH: '/nonexistent' },
		encoding: 'utf8',
	})
	return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

const hostPath = (home, profile = 'web') =>
	join(home, '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', HOST_PKG, 'lib', 'index.js')
const clientPath = (home, profile = 'web') =>
	join(home, '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', CLIENT_PKG, 'lib', 'client.js')

const tree = (host = HOST_PRISTINE, client = CLIENT_PRISTINE, version = '0.1.7-rc.2') => ({
	web: {
		[HOST_PKG]: { file: join('lib', 'index.js'), version, content: host },
		[CLIENT_PKG]: { file: join('lib', 'client.js'), version, content: client },
	},
})

// ---------------------------------------------------------------------------
// 1. Apply
// ---------------------------------------------------------------------------
{
	const home = makeHome(tree())
	const { code, out } = run(home)
	const host = readFileSync(hostPath(home), 'utf8')
	const client = readFileSync(clientPath(home), 'utf8')
	record(
		'apply: host schema + optionOf passthrough, client optionGlyph, exit 0',
		code === 0 &&
			out.includes('patched') &&
			host.includes('icon: z.string()') &&
			host.includes('...spec.icon !== void 0 ? { icon: spec.icon } : {}') &&
			client.includes('dsh-automode: icon patch') &&
			client.includes('const icon = optionGlyph(option);') &&
			client.includes('optionGlyph(current)') &&
			client.includes('function optionGlyph(option)'),
		`exit=${code}`,
	)
	record(
		'apply: pristine backups written next to both files',
		readFileSync(`${hostPath(home)}${BACKUP_SUFFIX}`, 'utf8') === HOST_PRISTINE &&
			readFileSync(`${clientPath(home)}${BACKUP_SUFFIX}`, 'utf8') === CLIENT_PRISTINE,
	)
	{
		const hostCheck = nodeCheck(hostPath(home))
		const clientCheck = nodeCheck(clientPath(home))
		record(
			'apply: both patched artifacts still parse (node --check)',
			hostCheck.ok && clientCheck.ok,
			hostCheck.ok ? clientCheck.detail || undefined : hostCheck.detail,
		)
	}
	record(
		'apply: injected client glyph is self-contained (no private primitives symbol)',
		client.includes('viewBox: "0 0 16 16"') &&
			client.includes('stroke: "currentColor"') &&
			!client.includes('shieldOutline'),
	)

	// -----------------------------------------------------------------------
	// 2. Idempotency
	// -----------------------------------------------------------------------
	const before = [readFileSync(hostPath(home), 'utf8'), readFileSync(clientPath(home), 'utf8')]
	const second = run(home)
	const after = [readFileSync(hostPath(home), 'utf8'), readFileSync(clientPath(home), 'utf8')]
	record(
		'idempotent: second run reports "already patched" and rewrites nothing',
		second.code === 0 &&
			(second.out.match(/already patched/g) ?? []).length === 2 &&
			before[0] === after[0] &&
			before[1] === after[1] &&
			// the pristine copies survive the no-op run
			readFileSync(`${hostPath(home)}${BACKUP_SUFFIX}`, 'utf8') === HOST_PRISTINE &&
			readFileSync(`${clientPath(home)}${BACKUP_SUFFIX}`, 'utf8') === CLIENT_PRISTINE,
		`exit=${second.code}`,
	)
}

// ---------------------------------------------------------------------------
// 3. --dry-run writes nothing
// ---------------------------------------------------------------------------
{
	const home = makeHome(tree())
	const { code, out } = run(home, ['--dry-run'])
	record(
		'dry-run: reports would-patch, touches no file, writes no backup',
		code === 0 &&
			(out.match(/would patch/g) ?? []).length === 2 &&
			readFileSync(hostPath(home), 'utf8') === HOST_PRISTINE &&
			readFileSync(clientPath(home), 'utf8') === CLIENT_PRISTINE &&
			!existsSync(`${hostPath(home)}${BACKUP_SUFFIX}`) &&
			!existsSync(`${clientPath(home)}${BACKUP_SUFFIX}`),
		`exit=${code}`,
	)
}

// ---------------------------------------------------------------------------
// 4. Anchor mismatch is atomic per file: that file stays byte-identical
// ---------------------------------------------------------------------------
{
	const broken = CLIENT_PRISTINE.replace('const icon = permissionGlyph(option.value);', 'const icon = build();')
	const home = makeHome(tree(HOST_PRISTINE, broken))
	const { code, out } = run(home)
	record(
		'anchor miss: mismatching file left byte-identical and named in the report, exit 1',
		code === 1 &&
			readFileSync(clientPath(home), 'utf8') === broken &&
			!existsSync(`${clientPath(home)}${BACKUP_SUFFIX}`) &&
			out.includes('ANCHORS NOT FOUND') &&
			out.includes('dropdown item glyph'),
		`exit=${code}`,
	)
	record(
		'anchor miss: the other (matching) file is still patched — decisions are per file',
		readFileSync(hostPath(home), 'utf8').includes('icon: z.string()'),
	)
}

// ---------------------------------------------------------------------------
// 5. A foreign / older injection is refused, not stacked — each trigger on its own
// ---------------------------------------------------------------------------
for (const [label, legacy] of [
	[
		'a shieldOutline reference (the previous generation)',
		CLIENT_PRISTINE.replace(
			'\t\tfunction permissionGlyph(value) {',
			'\t\tfunction optionGlyph(option) {\n\t\t\treturn shieldOutline\n\t\t}\n\t\tfunction permissionGlyph(value) {',
		),
	],
	[
		'an unrecognized optionGlyph already defined',
		CLIENT_PRISTINE.replace(
			'\t\tfunction permissionGlyph(value) {',
			'\t\tfunction optionGlyph(option) {\n\t\t\treturn option\n\t\t}\n\t\tfunction permissionGlyph(value) {',
		),
	],
]) {
	const home = makeHome(tree(HOST_PRISTINE, legacy))
	const { code, out } = run(home)
	record(
		`foreign injection (${label}): refused, file byte-identical, exit 1`,
		code === 1 && readFileSync(clientPath(home), 'utf8') === legacy && out.includes('REFUSED'),
		`exit=${code}`,
	)
}

// ---------------------------------------------------------------------------
// 6. Older DSH lines are skipped without noise
// ---------------------------------------------------------------------------
{
	const home = makeHome(tree('old host', 'old client', '0.1.2-rc.1'))
	const { code, out } = run(home)
	record(
		'older line: skipped quietly, exit 0, files untouched',
		code === 0 &&
			(out.match(/skipped \(older DSH line\)/g) ?? []).length === 2 &&
			readFileSync(hostPath(home), 'utf8') === 'old host' &&
			readFileSync(clientPath(home), 'utf8') === 'old client',
		`exit=${code}`,
	)
}

// ---------------------------------------------------------------------------
// 7. Argument handling: --profile selects one profile; bad usage exits 2
// ---------------------------------------------------------------------------
{
	const home = makeHome({ ...tree(), other: tree().web })
	const { code } = run(home, ['--profile', 'web'])
	record(
		'--profile web: patches the named profile only',
		code === 0 &&
			readFileSync(hostPath(home, 'web'), 'utf8').includes('icon: z.string()') &&
			readFileSync(hostPath(home, 'other'), 'utf8') === HOST_PRISTINE,
		`exit=${code}`,
	)
	record(
		'--profile=web: equal form is honoured too',
		run(makeHome({ ...tree(), other: tree().web }), ['--profile=web']).code === 0,
	)
}
{
	const home = makeHome(tree())
	const bare = run(home, ['--profile'])
	const unknown = run(home, ['--all'])
	record(
		'bad usage: bare --profile and unknown flags exit 2 and write nothing',
		bare.code === 2 &&
			bare.out.includes('--profile needs a profile name') &&
			unknown.code === 2 &&
			unknown.out.includes('unknown argument') &&
			readFileSync(hostPath(home), 'utf8') === HOST_PRISTINE,
		`bare=${bare.code} unknown=${unknown.code}`,
	)
	const missing = run(home, ['--profile', 'nosuch'])
	record(
		'unknown profile name: nothing to patch, exit 1, files untouched',
		missing.code === 1 && readFileSync(hostPath(home), 'utf8') === HOST_PRISTINE,
		`exit=${missing.code}`,
	)
}

// ---------------------------------------------------------------------------
// 8. Symlinked trees: a profile that reaches another profile's packages is
//    patched once, at the real path — nothing is written twice or by surprise.
//    `a)` the whole `node_modules` is a link, `b)` the `@deepseek-ai` entry
//    inside a real `node_modules` is (the shape this machine ships for
//    `profiles/peakrate-test`), which is disclosed in the report.
// ---------------------------------------------------------------------------
{
	const home = makeHome(tree())
	const alias = join(home, '.dsh', 'profiles', 'alias')
	mkdirSync(alias, { recursive: true })
	symlinkSync(join(home, '.dsh', 'profiles', 'web', 'node_modules'), join(alias, 'node_modules'), 'dir')

	const linked = join(home, '.dsh', 'profiles', 'linked')
	mkdirSync(join(linked, 'node_modules'), { recursive: true })
	symlinkSync(
		join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'),
		join(linked, 'node_modules', '@deepseek-ai'),
		'dir',
	)

	const { code, out } = run(home)
	const patched = out.split('\n').filter((line) => line.includes('patched  '))
	record(
		'symlinked node_modules: patched once at the real path, both link shapes written exactly twice',
		code === 0 &&
			patched.length === 2 &&
			patched.every((line) => line.includes('profiles/web/node_modules/@deepseek-ai')) &&
			!out.includes('profiles/alias/node_modules/@deepseek-ai/dsh') &&
			readFileSync(hostPath(home), 'utf8').includes('icon: z.string()'),
		`exit=${code}`,
	)
	record(
		'symlinked @deepseek-ai entry: disclosed in the report as reached-through',
		out.includes('reached through ~/.dsh/profiles/linked/node_modules/@deepseek-ai/'),
	)
}

// ---------------------------------------------------------------------------
// 9. Adaptive: the **real** 0.1.7-rc.2 artifacts, copied into a scratch HOME.
//    Covers bytes no synthetic fixture can drift from: the anchors match, the
//    write path produces parseable files, a second run is a no-op, and a
//    tampered copy is left byte-identical.
// ---------------------------------------------------------------------------
const realArtifacts = () => {
	const profiles = join(homedir(), '.dsh', 'profiles')
	if (!existsSync(profiles)) return undefined
	for (const name of readdirSync(profiles)) {
		const pkgDir = join(profiles, name, 'node_modules', '@deepseek-ai', HOST_PKG)
		const host = join(pkgDir, 'lib', 'index.js')
		const client = join(profiles, name, 'node_modules', '@deepseek-ai', CLIENT_PKG, 'lib', 'client.js')
		if (!existsSync(host) || !existsSync(client)) continue
		try {
			return { host, client, version: JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version }
		} catch {
			/* unreadable manifest — keep looking */
		}
	}
	return undefined
}

{
	const real = realArtifacts()
	if (real === undefined || !/^0\.1\.7-/.test(real.version)) {
		record('real 0.1.7-rc.2 artifacts', true, 'SKIP — no 0.1.7 install on this machine')
	} else {
		const scratch = (hostBytes, clientBytes) =>
			makeHome({
				web: {
					[HOST_PKG]: { file: join('lib', 'index.js'), version: real.version, content: hostBytes },
					[CLIENT_PKG]: { file: join('lib', 'client.js'), version: real.version, content: clientBytes },
				},
			})
		// The install this test reads is the developer's own and may already be
		// patched (that is the normal state after following the README): the
		// backup sidecar, when present, is the pristine original.
		const pristineOf = (file) => {
			const backup = `${file}${BACKUP_SUFFIX}`
			return existsSync(backup) ? readFileSync(backup, 'utf8') : readFileSync(file, 'utf8')
		}
		const hostBytes = pristineOf(real.host)
		const clientBytes = pristineOf(real.client)

		const home = scratch(hostBytes, clientBytes)
		const first = run(home)
		const hostCheck = nodeCheck(hostPath(home))
		const clientCheck = nodeCheck(clientPath(home))
		record(
			'real artifacts: patch applies, both files parse, exit 0',
			first.code === 0 &&
				hostCheck.ok &&
				clientCheck.ok &&
				readFileSync(hostPath(home), 'utf8').includes('icon: z.string()'),
			first.code === 0 ? hostCheck.detail || clientCheck.detail || undefined : `exit=${first.code}\n${first.out}`,
		)

		const second = run(home)
		record(
			'real artifacts: second run is a no-op (idempotent)',
			second.code === 0 && (second.out.match(/already patched/g) ?? []).length === 2,
			`exit=${second.code}`,
		)

		const tampered = clientBytes.replace('const icon = permissionGlyph(option.value);', 'const icon = build();')
		const home2 = scratch(hostBytes, tampered)
		const missed = run(home2)
		record(
			'real artifacts, tampered copy: reported, left byte-identical, no backup, exit 1',
			missed.code === 1 &&
				readFileSync(clientPath(home2), 'utf8') === tampered &&
				!existsSync(`${clientPath(home2)}${BACKUP_SUFFIX}`) &&
				missed.out.includes('ANCHORS NOT FOUND'),
			`exit=${missed.code}`,
		)

		// Whatever state the developer's own install is in, the script must agree
		// with it instead of rewriting or refusing it.
		const liveAlreadyPatched = readFileSync(real.client, 'utf8').includes(CLIENT_MARKER_TEXT)
		const liveHome = scratch(readFileSync(real.host, 'utf8'), readFileSync(real.client, 'utf8'))
		const liveRun = run(liveHome)
		record(
			`live install as-is (${liveAlreadyPatched ? 'already patched' : 'pristine'}): reported as such, exit 0`,
			liveRun.code === 0 &&
				(liveAlreadyPatched
					? (liveRun.out.match(/already patched/g) ?? []).length === 2
					: (liveRun.out.match(/patched  /g) ?? []).length === 2),
			`exit=${liveRun.code}`,
		)
	}
}

// ---------------------------------------------------------------------------
// 10. Adaptive: the anchors really match the install this machine is running.
//     **Dry run only** — the real `node_modules` is never written by the tests.
// ---------------------------------------------------------------------------
{
	const { code, out } = run(process.env.HOME ?? tmpdir(), ['--dry-run'])
	const live = /(would patch|already patched|patched)\s+~.*\(@deepseek-ai\/[^)]*0\.1\.7-/.test(out)
	if (!live) record('live 0.1.7-rc.2 install: anchors match', true, 'SKIP — no 0.1.7 target on this machine')
	else
		record(
			'live 0.1.7-rc.2 install: anchors match (dry run, nothing written)',
			code === 0 && !out.includes('ANCHORS NOT FOUND'),
			code === 0 ? `exit=${code}` : `exit=${code}\n${out}`,
		)
}

for (const home of homes) rmSync(home, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
