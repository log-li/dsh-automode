#!/usr/bin/env node
/**
 * Self-test for `patches/dsh-permission-preset-icon.mjs`.
 *
 * The patch edits built DSH artifacts inside `node_modules`, so the tests run it
 * as a child process against a **synthetic** `HOME` whose profile tree carries
 * exactly the anchors of the DSH 0.1.7-rc.2 line — hermetic, no real install is
 * touched, and the fixtures double as the written-down anchor contract.
 *
 * Two host fixtures exist on purpose: `HOST_PRISTINE` (no `icon` support, the
 * shape every 0.1.7/0.2.x release ships) and `HOST_NATIVE` (the anchor output
 * already present, as a DSH release that supports preset `icon` itself would
 * ship it). The second one is what tells `natively supported` apart from
 * `already patched` — a distinction that only the backup sidecar can settle.
 *
 * The adaptive checks at the end run against the **real** `HOME` and derive
 * their expectations from the bytes on disk (marker present? sidecar present?)
 * instead of from a DSH version number, so they hold on any line that gets
 * tested. They report SKIP (never fail) when no target exists.
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
/** Marker a patched *or* a natively-supporting host artifact contains. */
const HOST_MARKER_TEXT = '...spec.icon !== void 0 ? { icon: spec.icon } : {}'

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

/**
 * `HOST_PRISTINE` with this patch's two host edits already applied — the bytes a
 * DSH release that supports preset `icon` natively would ship. Identical to what
 * the script writes, which is exactly why the marker alone cannot say who wrote
 * it.
 */
const HOST_NATIVE = HOST_PRISTINE.replace(
	'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\t\tname: z.string(),\n\t\t\t\tdescription: z.string()',
	'approval: z.union(APPROVAL_POLICIES).required(),\n\t\t\t\tname: z.string(),\n\t\t\t\tdescription: z.string(),\n\t\t\t\ticon: z.string()',
).replace(
	'...spec.description !== void 0 ? { description: spec.description } : {}',
	'...spec.description !== void 0 ? { description: spec.description } : {},\n\t\t\t...spec.icon !== void 0 ? { icon: spec.icon } : {}',
)

// A fixture that failed to take its edits would silently turn the native cases
// into ordinary "patched" cases, so fail loudly instead.
if (!HOST_NATIVE.includes(HOST_MARKER_TEXT) || !HOST_NATIVE.includes('icon: z.string()')) {
	throw new Error('HOST_NATIVE fixture no longer contains the host edits — update the fixture')
}

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

/** The report line for one package, so assertions can target a half. */
const lineFor = (out, pkg) =>
	out.split('\n').find((line) => line.includes(`(@deepseek-ai/${pkg} `)) ?? '(no line reported)'

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
// 2b. Native host: the anchor output is present but this script never wrote it
//     (no `.bak` sidecar) — that is stock DSH's own code, and calling it
//     "already patched" would be a false claim about who changed the file.
//     The client half must still be handled in the same run.
// ---------------------------------------------------------------------------
{
	const home = makeHome(tree(HOST_NATIVE, CLIENT_PRISTINE, '0.2.1-rc.2'))
	const { code, out } = run(home)
	record(
		'native host: reported "natively supported" (never "already patched"), byte-identical, no sidecar written',
		code === 0 &&
			/natively supported/.test(lineFor(out, HOST_PKG)) &&
			!/already patched/.test(out) &&
			readFileSync(hostPath(home), 'utf8') === HOST_NATIVE &&
			!existsSync(`${hostPath(home)}${BACKUP_SUFFIX}`),
		`exit=${code}`,
	)
	record(
		'native host: the client half is still patched, and still parses',
		/patched/.test(lineFor(out, CLIENT_PKG)) &&
			readFileSync(clientPath(home), 'utf8').includes(CLIENT_MARKER_TEXT) &&
			nodeCheck(clientPath(home)).ok,
	)
	record(
		'native host: the tail says the host half needs nothing and the client half still does',
		out.includes('Host half: natively supported') &&
			out.includes('Client half: still needs this patch'),
	)

	const second = run(home)
	record(
		'native host: a rerun repeats the verdict and rewrites nothing',
		second.code === 0 &&
			/natively supported/.test(lineFor(second.out, HOST_PKG)) &&
			/already patched/.test(lineFor(second.out, CLIENT_PKG)) &&
			readFileSync(hostPath(home), 'utf8') === HOST_NATIVE,
		`exit=${second.code}`,
	)
}
{
	// Dry run on the same shape must not write and must not claim a host edit.
	const home = makeHome(tree(HOST_NATIVE, CLIENT_PRISTINE, '0.2.1-rc.2'))
	const { code, out } = run(home, ['--dry-run'])
	record(
		'native host, dry run: "natively supported" plus "would patch" for the client, nothing written',
		code === 0 &&
			/natively supported/.test(lineFor(out, HOST_PKG)) &&
			/would patch/.test(lineFor(out, CLIENT_PKG)) &&
			(out.match(/would patch/g) ?? []).length === 1 &&
			readFileSync(hostPath(home), 'utf8') === HOST_NATIVE &&
			readFileSync(clientPath(home), 'utf8') === CLIENT_PRISTINE &&
			!existsSync(`${clientPath(home)}${BACKUP_SUFFIX}`),
		`exit=${code}`,
	)
}
{
	// A sidecar left behind by some older generation cannot fake "already
	// patched": the marker is ordinary DSH code, and this sidecar does not
	// reproduce the file, so the verdict stays "natively supported".
	const home = makeHome(tree(HOST_NATIVE, CLIENT_PRISTINE, '0.2.1-rc.2'))
	writeFileSync(`${hostPath(home)}${BACKUP_SUFFIX}`, '// bytes from an older patched generation\n')
	const { code, out } = run(home, ['--dry-run'])
	record(
		'stale sidecar: a backup that does not reproduce the file still means "natively supported"',
		code === 0 && /natively supported/.test(lineFor(out, HOST_PKG)) && !/already patched/.test(out),
		`exit=${code}`,
	)
}
{
	// The same stale sidecar through a REAL run, with byte assertions: neither the
	// host file nor the stale sidecar may be touched, so a wrong verdict cannot
	// also rewrite the evidence it was based on.
	const home = makeHome(tree(HOST_NATIVE, CLIENT_PRISTINE, '0.2.1-rc.2'))
	const stale = '// bytes from an older patched generation\n'
	writeFileSync(`${hostPath(home)}${BACKUP_SUFFIX}`, stale)
	const { code } = run(home)
	record(
		'stale sidecar, real run: host bytes and the stale sidecar both left byte-identical',
		code === 0 &&
			readFileSync(hostPath(home), 'utf8') === HOST_NATIVE &&
			readFileSync(`${hostPath(home)}${BACKUP_SUFFIX}`, 'utf8') === stale,
		`exit=${code}`,
	)
}

{
	// Native host plus a client anchor that moved: the tail must not claim the
	// client half is taken care of just because the host half is native.
	const broken = CLIENT_PRISTINE.replace('const icon = permissionGlyph(option.value);', 'const icon = build();')
	const home = makeHome(tree(HOST_NATIVE, broken, '0.2.1-rc.2'))
	const { code, out } = run(home)
	record(
		'native host + client anchor miss: exit 1, tail never claims the client is patched',
		code === 1 &&
			/natively supported/.test(lineFor(out, HOST_PKG)) &&
			!/Client half: already patched/.test(out) &&
			/Client half: left untouched/.test(out),
		`exit=${code}`,
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
// 9. Adaptive: the **real** artifacts this machine has installed, copied into a
//    scratch HOME. Covers bytes no synthetic fixture can drift from: the anchors
//    match, the write path produces parseable files, a rerun settles, and a
//    tampered copy is left byte-identical.
//
//    Expectations are derived from those bytes (marker? sidecar?), never from a
//    version number: 0.1.7 installs are gone from some machines and 0.2.x is the
//    line under test today.
// ---------------------------------------------------------------------------
const realArtifacts = () => {
	const roots = []
	const profiles = join(homedir(), '.dsh', 'profiles')
	if (existsSync(profiles)) {
		for (const name of readdirSync(profiles)) roots.push(join(profiles, name, 'node_modules', '@deepseek-ai'))
	}
	roots.push(join(profiles, 'node_modules', '@deepseek-ai'))
	const globalRoot = join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
	roots.push(globalRoot)
	for (const root of roots) {
		const pkgDir = join(root, HOST_PKG)
		const host = join(pkgDir, 'lib', 'index.js')
		const client = join(root, CLIENT_PKG, 'lib', 'client.js')
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
	if (real === undefined) {
		record('real install: host/client artifacts', true, 'SKIP — no permission-preset packages on this machine')
	} else {
		const sidecarOf = (file) =>
			existsSync(`${file}${BACKUP_SUFFIX}`) ? readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8') : undefined
		const installed = { host: readFileSync(real.host, 'utf8'), client: readFileSync(real.client, 'utf8') }
		// What this script would have seen before it (or anything else) edited the
		// files: the sidecar when one exists, the file itself otherwise.
		const pristine = { host: sidecarOf(real.host) ?? installed.host, client: sidecarOf(real.client) ?? installed.client }
		const scratch = (hostBytes, clientBytes) =>
			makeHome({
				web: {
					[HOST_PKG]: { file: join('lib', 'index.js'), version: real.version, content: hostBytes },
					[CLIENT_PKG]: { file: join('lib', 'client.js'), version: real.version, content: clientBytes },
				},
			})
		const hostHasMarker = installed.host.includes(HOST_MARKER_TEXT)
		const clientHasMarker = installed.client.includes(CLIENT_MARKER_TEXT)
		const hostProven = sidecarOf(real.host) !== undefined

		// a) exactly as it sits on disk, sidecars included: the script has to agree
		//    with whoever wrote those bytes instead of claiming a new edit.
		const asIs = scratch(installed.host, installed.client)
		if (pristine.host !== installed.host) writeFileSync(`${hostPath(asIs)}${BACKUP_SUFFIX}`, pristine.host)
		if (pristine.client !== installed.client) writeFileSync(`${clientPath(asIs)}${BACKUP_SUFFIX}`, pristine.client)
		const first = run(asIs)
		const hostSaid = lineFor(first.out, HOST_PKG)
		const clientSaid = lineFor(first.out, CLIENT_PKG)
		record(
			`real install as-is (${real.version}): host ${
				hostHasMarker ? (hostProven ? 'reported "already patched"' : 'reported "natively supported"') : 'patched'
			}, client ${clientHasMarker ? 'left as patched' : 'patched'}, exit 0`,
			first.code === 0 &&
				(hostHasMarker
					? (hostProven ? /already patched/.test(hostSaid) : /natively supported/.test(hostSaid)) &&
						readFileSync(hostPath(asIs), 'utf8') === installed.host
					: /patched/.test(hostSaid) && readFileSync(hostPath(asIs), 'utf8').includes('icon: z.string()')) &&
				(clientHasMarker
					? /already patched/.test(clientSaid) && readFileSync(clientPath(asIs), 'utf8') === installed.client
					: /patched/.test(clientSaid) && readFileSync(clientPath(asIs), 'utf8').includes(CLIENT_MARKER_TEXT)),
			`exit=${first.code}`,
		)

		// b) from the pristine copies: the write path, parseability, and a settle.
		const applyHome = scratch(pristine.host, pristine.client)
		const second = run(applyHome)
		const hostCheck = nodeCheck(hostPath(applyHome))
		const clientCheck = nodeCheck(clientPath(applyHome))
		record(
			'real artifacts from the pristine copies: patched as expected, both files parse',
			second.code === 0 &&
				(pristine.host.includes(HOST_MARKER_TEXT)
					? /natively supported/.test(lineFor(second.out, HOST_PKG))
					: /patched/.test(lineFor(second.out, HOST_PKG))) &&
				(pristine.client.includes(CLIENT_MARKER_TEXT)
					? /already patched/.test(lineFor(second.out, CLIENT_PKG))
					: /patched/.test(lineFor(second.out, CLIENT_PKG))) &&
				hostCheck.ok &&
				clientCheck.ok &&
				readFileSync(hostPath(applyHome), 'utf8').includes('icon: z.string()'),
			second.code === 0 ? hostCheck.detail || clientCheck.detail || undefined : `exit=${second.code}\n${second.out}`,
		)
		const third = run(applyHome)
		record(
			'real artifacts: rerunning over the applied copies is a no-op for both halves',
			third.code === 0 &&
				/already patched|natively supported/.test(lineFor(third.out, HOST_PKG)) &&
				/already patched/.test(lineFor(third.out, CLIENT_PKG)),
			`exit=${third.code}`,
		)

		// c) tampered copy: reported, never written.
		const anchor = 'const icon = permissionGlyph(option.value);'
		if (!pristine.client.includes(anchor)) {
			record('real artifacts, tampered copy', true, 'SKIP — this client bundle has no dropdown anchor to tamper with')
		} else {
			const tampered = pristine.client.replace(anchor, 'const icon = build();')
			const home2 = scratch(pristine.host, tampered)
			const missed = run(home2)
			record(
				'real artifacts, tampered copy: reported, left byte-identical, no sidecar, exit 1',
				missed.code === 1 &&
					readFileSync(clientPath(home2), 'utf8') === tampered &&
					!existsSync(`${clientPath(home2)}${BACKUP_SUFFIX}`) &&
					missed.out.includes('ANCHORS NOT FOUND'),
				`exit=${missed.code}`,
			)
		}

		// d) the real host bytes with the sidecar dropped are indistinguishable from
		//    a host release that ships the passthrough itself — the precise case
		//    this verdict exists for. Real bytes, not the minimal fixture.
		if (!hostHasMarker) {
			record('real host bytes without the sidecar', true, 'SKIP — the installed host has no passthrough to attribute')
		} else {
			const bare = scratch(installed.host, pristine.client)
			const bareRun = run(bare, ['--dry-run'])
			record(
				'real host bytes with no sidecar: "natively supported", never "already patched"',
				bareRun.code === 0 &&
					/natively supported/.test(lineFor(bareRun.out, HOST_PKG)) &&
					!/already patched/.test(lineFor(bareRun.out, HOST_PKG)),
				`exit=${bareRun.code}`,
			)
		}
	}
}

// ---------------------------------------------------------------------------
// 10. Adaptive: the dry run agrees with the install this machine is running.
//     **Dry run only** — the real `node_modules` is never written by the tests.
//
//     The check is a per-target invariant, so it holds on any DSH line: a
//     "natively supported" host must carry the marker and no sidecar, an
//     "already patched" host must carry both, a client claimed as patched must
//     carry our marker, and a client claimed as needing the patch must not.
// ---------------------------------------------------------------------------
{
	const home = process.env.HOME ?? tmpdir()
	const { code, out } = run(home, ['--dry-run'])
	const lines = out.split('\n')
	const targetsOf = (pkg) =>
		lines.filter((line) => line.includes(`(@deepseek-ai/${pkg} `) && !line.includes('older DSH line'))
	const pathOf = (line) => {
		const head = line.split('  (@deepseek-ai/')[0]
		const token = head
			.split(/\s+/)
			.filter((part) => part.startsWith('~') || part.startsWith('/'))
			.pop()
		if (token === undefined) return undefined
		return token.replace(/^~\//, `${home}/`)
	}
	const violations = []
	for (const line of targetsOf(HOST_PKG)) {
		const file = pathOf(line)
		if (file === undefined || !existsSync(file)) {
			violations.push(`no readable path in: ${line.trim()}`)
			continue
		}
		const marker = readFileSync(file, 'utf8').includes(HOST_MARKER_TEXT)
		const backed = existsSync(`${file}${BACKUP_SUFFIX}`)
		if (line.includes('natively supported')) {
			if (!marker || backed) violations.push(`"natively supported" unproven: ${line.trim()}`)
		} else if (line.includes('already patched')) {
			if (!marker || !backed) violations.push(`"already patched" unproven: ${line.trim()}`)
		} else if (marker) {
			violations.push(`patch planned for a file that already has the passthrough: ${line.trim()}`)
		}
	}
	for (const line of targetsOf(CLIENT_PKG)) {
		const file = pathOf(line)
		if (file === undefined || !existsSync(file)) {
			violations.push(`no readable path in: ${line.trim()}`)
			continue
		}
		const marker = readFileSync(file, 'utf8').includes(CLIENT_MARKER_TEXT)
		if (line.includes('already patched') && !marker) violations.push(`"already patched" without our marker: ${line.trim()}`)
		if (!line.includes('already patched') && marker) violations.push(`patch planned for a patched client: ${line.trim()}`)
	}
	const targets = targetsOf(HOST_PKG).length + targetsOf(CLIENT_PKG).length
	if (targets === 0) {
		record(
			'live install: dry run agrees with what is on disk',
			true,
			'SKIP — no ≥0.1.7 permission-preset target on this machine',
		)
	} else {
		record(
			`live install (${targetsOf(HOST_PKG).length} host + ${targetsOf(CLIENT_PKG).length} client target(s)): dry run agrees with what is on disk`,
			code === 0 && !out.includes('ANCHORS NOT FOUND') && !out.includes('REFUSED') && violations.length === 0,
			violations.length === 0 ? `exit=${code}` : violations.join(' | '),
		)
	}
}

for (const home of homes) rmSync(home, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
