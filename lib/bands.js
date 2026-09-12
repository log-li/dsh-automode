/**
 * Deterministic band engine — the fast path that runs before the classifier.
 *
 * Two band types:
 *   deny  — regex patterns that hard-reject (exfiltration, secrets, deletion,
 *           sensitive targets). Evaluated first; first match wins.
 *   allow — prefix-glob patterns that zero-LLM approve (routine commands,
 *           curated paths). Evaluated after deny; first match wins.
 *
 * Read-only tools are allowed by default unless they match a deny pattern.
 * Everything else falls through to the classifier.
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js (decideRoute + helpers).
 */
import { resolve } from 'node:path';
/** Expand `~` and `${HOME}`/`$HOME` at the front of a path (for `cd ~` and `git -C ~`).
 * Left as-is when `HOME` is empty. */
export function expandHome(p) {
    const home = process.env.HOME ?? '';
    return p.replace(/^~(?=$|\/)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
}
/** Compile a rule string into a case-insensitive RegExp. */
export function compileRegex(rule) {
    return new RegExp(rule, 'i');
}
/** Whether `haystack` matches any regex in the list. Returns the first hit. */
export function matchRule(rules, haystack) {
    for (const re of rules) {
        if (re.test(haystack))
            return re.source;
    }
    return null;
}
/** Compile a prefix-glob into an anchored RegExp (leading/trailing * wildcards). */
export function compileGlob(pattern) {
    let source = '';
    for (const ch of pattern) {
        if (ch === '*')
            source += '.*';
        else
            source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`, 'i');
}
/** Whether `text` matches any compiled glob. */
export function matchAllow(globs, text) {
    for (const g of globs) {
        if (g.test(text))
            return g.source;
    }
    return null;
}
/** Extract the command field from tool arguments (string or object). */
export function bashCommandOf(args) {
    if (typeof args === 'string') {
        try {
            const obj = JSON.parse(args);
            return typeof obj?.command === 'string' ? obj.command : '';
        }
        catch {
            return args;
        }
    }
    if (args && typeof args === 'object' && typeof args.command === 'string') {
        return args.command;
    }
    return '';
}
/** Detect shell metacharacters that indicate a composite command.
 * Quote-aware: control characters inside quotes are literal — a quoted
 * filename like "GRF 2026 (copy).docx" is NOT a subshell — and only an
 * unquoted `; & | > \` $ ( )` marks the command as composite. */
export function isCompositeShell(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i] ?? '';
        if (quote) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/[;&|>`$()]/.test(ch))
            return true;
    }
    return false;
}
/** Quote-aware shell tokenization (no metachar expansion, no env substitution). */
export function tokenizeShell(cmd) {
    const tokens = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i] ?? '';
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                tokens.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        tokens.push(cur);
    return tokens;
}
/** Last argv token that does not look like a flag (used as a command's destination). */
function lastPositional(argv) {
    for (let i = argv.length - 1; i >= 0; i--) {
        const a = argv[i];
        if (a && !a.startsWith('-'))
            return a;
    }
    return undefined;
}
/**
 * Bash write-commands that write files at an explicit destination path
 * (used for the curated allowPath trust check on non-file tools).
 * Irrecoverable deletion commands (`rm`, `shred`, `unlink`) are intentionally
 * NOT here — allowPaths trust never authorizes removal. `trash` IS here
 * (v0.13.0): it is a RECOVERABLE delete (freedesktop trash / trash-cli), the
 * deny band still hard-rejects `trash|mv` against system paths before this
 * table is consulted, and `destinationsOf('trash')` returns every positional
 * target so the allowPath check requires ALL of them inside the trusted roots
 * (otherwise the whole call falls back to the classifier).
 */
const BASH_WRITE_COMMANDS = new Set([
    'cp', 'mv', 'rsync', 'ditto', 'install', 'tar', 'unzip', 'unar', 'curl', 'wget', 'git', 'trash',
]);
/**
 * Non-writing utility commands allowed inside a COMPOSITE command without
 * invalidating the allowPath fast path (2026-09-01 Issue B guard). Every other
 * non-write command — side-effect commands (`kill`, `pkill`, `systemctl`,
 * `launchctl`, `brew`, `docker`, …), interpreters (`sh`, `bash`, `python`,
 * `node`), deletion (`rm`, `shred`), unknown commands — makes the WHOLE
 * composite fall back to the classifier, so multi-step attacks like
 * `curl -o /tmp/e … && bash /tmp/e` never get allowPath trust from their
 * benign-looking write segment.
 */
const BENIGN_UTILITY_COMMANDS = new Set([
    'echo', 'printf', 'ls', 'mkdir', 'test', '[', 'true', 'false', 'pwd',
    'stat', 'file', 'wc', 'head', 'tail', 'which', 'dirname', 'basename',
    'date', 'sleep', 'uname', 'id', 'du', 'df', 'sort', 'uniq', 'cat',
]);
/**
 * Split a composite shell command into top-level segments on `;`, `&&`, `||`,
 * `|`, `&` and newlines — quote- and paren-aware, so a separator inside quotes
 * or inside a `(...)` / `$(...)` group is literal (`(trash b; true)` is ONE
 * segment). An `&` that is an fd-dup redirection (e.g. `2>&1`, `>&2`, `>&-`) is
 * NOT a command separator — `git push … 2>&1 | tail` stays ONE segment up to
 * the pipe (2026-09-04 git allowPath bug).
 */
function splitShellSegments(cmd) {
    const segments = [];
    let cur = '';
    let quote = null;
    let paren = 0;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i] ?? '';
        if (quote) {
            cur += ch;
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === '(') {
            paren += 1;
            cur += ch;
            continue;
        }
        if (ch === ')') {
            paren = Math.max(0, paren - 1);
            cur += ch;
            continue;
        }
        if (paren === 0 && (ch === ';' || ch === '\n' || ch === '|' || ch === '&')) {
            // `2>&1` / `>&2` / `>&-` : the `&` is part of a descriptor-dup redirection,
            // not a command separator — keep it in the current segment.
            if (ch === '&' && cur.endsWith('>')) {
                cur += ch;
                continue;
            }
            if (cur.trim())
                segments.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim())
        segments.push(cur.trim());
    return segments;
}
/**
 * Parse a segment that is a pure `VAR=value` / `export VAR=value` assignment.
 * Returns `[name, value]` or undefined. A value with unquoted whitespace is
 * NOT a pure assignment (`FOO=bar cmd …` is a command, not an assignment).
 */
function parseAssignment(seg) {
    let s = seg.trim();
    if (s.startsWith('export '))
        s = s.slice('export '.length).trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(s);
    if (!m)
        return undefined;
    const val = m[2] ?? '';
    const fullyQuoted = (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) ||
        (val.length >= 2 && val.startsWith("'") && val.endsWith("'"));
    if (val && !fullyQuoted && /\s/.test(val))
        return undefined;
    return [m[1] ?? '', fullyQuoted ? val.slice(1, -1) : val];
}
/**
 * Expand `$VAR` / `${VAR}` tokens using the captured assignment map. Unknown
 * variables are left literal — their destinations then fail the allowPath
 * match and fall back to the classifier (fail-closed, never a false trust).
 */
function expandShellVars(text, vars) {
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
        const name = braced ?? plain;
        return vars.has(name) ? vars.get(name) : whole;
    });
}
/** Whether a segment contains an unquoted redirection that writes a FILE
 * (`>`, `>>`, `2>`, `2>>`). A descriptor-dup redirection (`2>&1`, `>&2`,
 * `>&-`, `2>&-`) only re-targets a file descriptor and is NOT a file write, so
 * it does not invalidate the allowPath fast path (2026-09-04 git bug). */
function hasUnquotedRedirect(seg) {
    let quote = null;
    for (let i = 0; i < seg.length; i++) {
        const ch = seg[i] ?? '';
        if (quote) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            let j = i + 1;
            if (seg[j] === '>')
                j++; // `>>` append
            if (seg[j] === '&') { // fd-dup (`>&` / `2>&`) — not a file write
                i = j;
                continue;
            }
            return true; // `>file` / `>>file` / `2>file` — a file redirect
        }
    }
    return false;
}
/** Destination(s) one write-command argv writes into (see the switch below).
 * `cwd` is the effective working directory a command runs in — for `git`
 * write-commands (`add`/`commit`/`push`) the writable "destination" is the
 * repository root, resolved from an explicit `-C <dir>` else from `cwd`. */
function destinationsOf(base, argv, cwd) {
    switch (base) {
        case 'trash': {
            // Recoverable delete (freedesktop trash / trash-cli, v0.13.0): every
            // positional argument is a TARGET moved to the recycle bin. The allowPath
            // check treats targets like write destinations: ALL of them must resolve
            // inside config.allowPaths, otherwise the whole call falls back to the
            // classifier. Irrecoverable deletes (`rm`, `shred`, `unlink`) are not in
            // BASH_WRITE_COMMANDS at all, and the deny band still hard-rejects
            // trash/mv against system paths before this table is reached.
            return argv.filter((a) => !a.startsWith('-'));
        }
        case 'cp':
        case 'mv':
        case 'rsync':
        case 'ditto':
        case 'install': {
            // --target-directory=/dest and -t /dest forms
            for (const a of argv) {
                if (a.startsWith('--target-directory='))
                    return [a.slice('--target-directory='.length)];
            }
            const tIdx = argv.findIndex((a) => a === '-t' || a === '--target-directory');
            const tDest = tIdx !== -1 ? argv[tIdx + 1] : undefined;
            if (tDest)
                return [tDest];
            const dest = lastPositional(argv);
            return dest ? [dest] : [];
        }
        case 'tar':
        case 'unzip':
        case 'unar': {
            // tar -C / --directory, unzip/unar -d / --directory (extract target)
            for (const a of argv) {
                if (a.startsWith('--directory='))
                    return [a.slice('--directory='.length)];
            }
            const dIdx = argv.findIndex((a) => a === '-C' || a === '-d' || a === '--directory');
            const dDest = dIdx !== -1 ? argv[dIdx + 1] : undefined;
            if (dDest)
                return [dDest];
            return []; // extracts into cwd by default — not an allowPath destination
        }
        case 'curl': {
            for (const a of argv) {
                if (a.startsWith('--output='))
                    return [a.slice('--output='.length)];
                if (a.startsWith('-o='))
                    return [a.slice(3)];
            }
            const oIdx = argv.findIndex((a) => a === '-o' || a === '--output');
            const oDest = oIdx !== -1 ? argv[oIdx + 1] : undefined;
            if (oDest)
                return [oDest];
            return [];
        }
        case 'wget': {
            for (const a of argv) {
                if (a.startsWith('--output-document='))
                    return [a.slice('--output-document='.length)];
                if (a.startsWith('-O='))
                    return [a.slice(3)];
            }
            const oIdx = argv.findIndex((a) => a === '-O' || a === '--output-document');
            const oDest = oIdx !== -1 ? argv[oIdx + 1] : undefined;
            if (oDest)
                return [oDest];
            return [];
        }
        case 'git': {
            // Resolve the repository root from an explicit `git -C <dir>` (repeatable,
            // last wins), else the effective working directory.
            let repo = cwd;
            for (let i = 0; i < argv.length; i++) {
                const a = argv[i] ?? '';
                if (a === '-C' && argv[i + 1]) {
                    repo = argv[i + 1];
                    i++;
                }
                else if (a.startsWith('-C') && a.length > 2) {
                    repo = a.slice(2);
                }
            }
            // First recognized subcommand — flags and their values are skipped so
            // `git -C /dir add .` is still seen as `add`.
            const sub = argv.find((a) => ['clone', 'add', 'commit', 'push'].includes(a)) ?? '';
            if (sub === 'clone') {
                // git clone <url> [dir] — the destination is the last arg when it is a
                // local path, not the repository URL (clone without a dir writes into cwd).
                const last = argv[argv.length - 1];
                if (last && !last.startsWith('-') && !/^(?:https?|git|ssh):\/\/|git@/.test(last))
                    return [last];
            }
            else if (sub === 'add' || sub === 'commit' || sub === 'push') {
                // add/commit/push write into the repo's `.git`, so the allowPath-checkable
                // destination is the repository root. (Deletion / history-rewrite commands
                // — `clean`, `reset --hard`, `rebase`, `merge` — are deliberately NOT here;
                // they stay in the classifier / hard-deny band.)
                if (repo)
                    return [resolve(cwd, expandHome(repo))];
            }
            return [];
        }
        default:
            return [];
    }
}
/**
 * Walk command segments, extracting write destinations into `dests` and
 * capturing `VAR=…` assignments into `vars`. Tracks the effective working
 * directory in `cwd` (a mutable ref) so `cd <dir>` updates it and a following
 * `git add/commit/push` resolves its repository root against it. Returns false
 * when any segment is not a recognized write command, a pure assignment, a
 * benign utility, a `cd`, or a subshell group — the caller then falls back to
 * the classifier for the WHOLE command.
 */
function collectSegmentDestinations(cmd, vars, dests, cwd) {
    const segments = isCompositeShell(cmd) ? splitShellSegments(cmd) : [cmd.trim()];
    for (const rawSeg of segments) {
        const seg = rawSeg.trim();
        if (!seg)
            continue;
        // Subshell group `(…; …)` — recurse (carries the same variable map).
        if (seg.startsWith('(') && seg.endsWith(')')) {
            if (!collectSegmentDestinations(seg.slice(1, -1), vars, dests, cwd))
                return false;
            continue;
        }
        // Command substitution / process substitution (`…`, $(…), <(…)) executes
        // arbitrary code we cannot statically verify — never allowPath-trust a
        // segment containing one (`cp a $(rm -rf /) /tmp/b` would otherwise extract
        // /tmp/b and let the substitution run; `<(rm -rf /)` is the process-
        // substitution variant). Checked BEFORE assignment parsing so a
        // `VAR="$(cmd)"` value is also refused (its expansion would smuggle the
        // substitution into a later destination). Conservative: this also covers
        // the non-composite backtick form, which is not flagged composite by
        // isCompositeShell.
        if (seg.includes('`') || seg.includes('$(') || seg.includes('<('))
            return false;
        const assign = parseAssignment(seg);
        if (assign) {
            vars.set(assign[0], assign[1]);
            continue;
        }
        // `cd <dir>` (or bare `cd` → HOME): pure navigation. Updates the effective
        // cwd so a later `git add/commit/push` resolves its repo root against it.
        // `cd -` (to $OLDPWD) is unpredictable — fail back to the classifier.
        const cdMatch = /^cd(?:\s+(.*))?$/.exec(seg);
        if (cdMatch) {
            const target = (cdMatch[1] ?? '').trim();
            if (target === '-')
                return false;
            if (target) {
                const ttokens = tokenizeShell(expandShellVars(target, vars));
                const dir = ttokens[0] ?? '';
                if (dir === '-' || dir === '')
                    return false;
                cwd.value = resolve(cwd.value, expandHome(dir));
            }
            else {
                cwd.value = expandHome('~');
            }
            continue;
        }
        // Redirection writes to a file we do not model — never allowPath-trust it.
        if (hasUnquotedRedirect(seg))
            return false;
        const tokens = tokenizeShell(seg);
        if (tokens.length === 0)
            continue;
        // v0.13.0: `~` tilde expansion on every token (in addition to `$HOME`,
        // which `expandShellVars` already resolves via the tracked vars map), so
        // write destinations like `~/bin/trash …`, `git clone <url> ~/dir` and
        // `cp a ~/dst` resolve to real paths before the allowPath check. Only
        // leading `~`/`~/$HOME` forms expand; `~user` stays literal (and then fails
        // realpath, falling back to the classifier — safe).
        const expanded = tokens.map((t) => expandHome(expandShellVars(t, vars)));
        const first = expanded[0] ?? '';
        const base = first.split('/').pop() ?? first;
        if (!BASH_WRITE_COMMANDS.has(base)) {
            if (BENIGN_UTILITY_COMMANDS.has(base))
                continue; // benign — no destination
            return false; // side-effect / unknown command → whole composite falls back
        }
        dests.push(...destinationsOf(base, expanded.slice(1), cwd.value));
    }
    return true;
}
/**
 * For a bash command, return the destination path(s) it writes into, or `[]`
 * when the command is not a recognized file-writing command, has no explicit
 * destination, or is a composite whose segments contain anything outside the
 * write / assignment / benign-utility / `cd` set (those fall back to the
 * classifier — 2026-09-01 Issue B). The destination is only ever the *target*
 * of the write; sources and unrelated path tokens are ignored.
 *
 * `cwd` is the working directory the command runs in (session cwd) — used to
 * resolve a bare `git add/commit/push` repository root and as the base for a
 * relative `cd`. Defaults to the host process cwd.
 */
export function bashWriteDestinations(cmd, cwd) {
    if (!cmd)
        return [];
    const vars = new Map([['HOME', process.env.HOME ?? '']]);
    const dests = [];
    const cwdState = { value: cwd || process.cwd() };
    if (!collectSegmentDestinations(cmd, vars, dests, cwdState))
        return [];
    return [...new Set(dests)];
}
/** Whether `text` contains a permanent-deletion command. */
export function matchDeletion(text) {
    if (!text)
        return null;
    const DELETION_RE = /(?:^|[;&|]\s*)(?:rm\s+(-[rRfIi]*\s+)*(?!.*node_modules)|unlink\s+|shred\s+|git\s+clean\s+-f)/;
    return DELETION_RE.test(text) ? 'permanent deletion command detected' : null;
}
/** Whether `text` is a read-only tool name. */
export function isReadOnlyTool(toolName, readOnlyTools) {
    return readOnlyTools.includes(toolName);
}
/** Whether the tool name is a file-path tool (targets are paths, not commands). */
export function isFileTool(name) {
    return ['read', 'write', 'edit', 'glob', 'grep', 'find', 'ls'].includes(name);
}
/** Collect candidate file/dir path strings from a file-tool call's args. */
export function collectPaths(args) {
    if (!args || typeof args !== 'object')
        return [];
    const out = [];
    for (const key of ['file_path', 'path', 'dir', 'root', 'pattern']) {
        const v = args[key];
        if (typeof v === 'string' && v)
            out.push(v);
        else if (Array.isArray(v))
            for (const item of v)
                if (typeof item === 'string')
                    out.push(item);
    }
    return out;
}
/** Collect only definitive filesystem-path argument values (no search patterns).
 * Used for deny scanning so a grep/glob search term is not mistaken for a target. */
export function collectDenyPaths(args) {
    if (!args || typeof args !== 'object')
        return [];
    const out = [];
    for (const key of ['file_path', 'path', 'dir', 'root']) {
        const v = args[key];
        if (typeof v === 'string' && v)
            out.push(v);
        else if (Array.isArray(v))
            for (const item of v)
                if (typeof item === 'string')
                    out.push(item);
    }
    return out;
}
/**
 * Deny-scan haystack shared by BOTH enforcement points (v0.14.4, review #1).
 * File tools scan only their TARGET PATHS — document content must NOT be
 * scanned (v0.11.1 design: mentioning a sensitive filename in prose is not a
 * leak). Bash scans the command text. Keeps the gate and the approval path
 * identical so the hard-deny band can never diverge between the two.
 */
export function denyHaystackFor(toolName, args, commandText) {
    if (isFileTool(toolName)) {
        return `${toolName}\n${collectDenyPaths(args).join('\n')}`;
    }
    const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    return `${toolName}\n${commandText || argsText}`;
}
/**
 * Built-in deny patterns that name a sensitive SUBJECT (a file, a store, an
 * environment variable) rather than an executable OPERATION.
 *
 * Matching these against a prose-bearing call — a subagent prompt, a workflow
 * script, an arbitrary tool's text argument — punishes *mentioning* a topic:
 * a code review that says "the key file", or a doc about the env file, was
 * hard-rejected before any classifier saw the call, and the only way through
 * was to mangle the wording. That is the same rule the file-tool haystack has
 * followed since v0.11.1 ("mentioning a sensitive filename in prose is not a
 * leak"); v0.15.1 extends it to every tool whose arguments are prose.
 *
 * OPERATION-shaped patterns (pipe-to-shell, inline key material, system-path
 * moves, docker volume removal) still apply everywhere: they describe what an
 * operation does, so prose that contains them is at least worth failing closed
 * on. The real operations such prose may later cause are separate tool calls
 * whose own command text and target paths are scanned in full.
 *
 * Every source here MUST exist in DEFAULT_DENY; a smoke test guards that.
 */
export const SUBJECT_ONLY_DENY_SOURCES = new Set([
    'AWS_SECRET',
    'authorized_keys',
    '\\.aws/credentials',
    '(?<![a-zA-Z0-9?.])\\.ssh/',
    '(?<![a-zA-Z0-9?.])\\.zshrc',
    '(?<![a-zA-Z0-9?.])\\.bashrc',
    '(?<![a-zA-Z0-9?.])\\.bash_profile',
    '(?<![a-zA-Z0-9?.])\\.profile\\b',
    '(?<![a-zA-Z0-9?.])\\.claude/settings',
    'id_rsa|id_ed25519',
    '(?<![a-zA-Z0-9?.])\\.pem\\b',
    '(?<![a-zA-Z0-9?.])\\.env\\b',
    '(?<![a-zA-Z0-9])(?:\\.credentials|credentials\\.(?:json|ya?ml))\\b',
]);
/** Whether this call's arguments are prose (no command text, not a file tool). */
export function isProseCarrier(toolName, commandText) {
    return !commandText && !isFileTool(toolName);
}
/**
 * The deny patterns to apply to a prose-bearing call: the built-in
 * subject-only patterns are dropped, everything else (including every
 * operator-configured pattern) still applies. Operator patterns are never
 * filtered — they are explicit rule authoring, not an incidental word.
 *
 * NOTE: `RegExp.source` escapes forward slashes (`\.ssh/` → `\.ssh\/`), so the
 * comparison must normalize before matching the raw DEFAULT_DENY strings —
 * otherwise every path-shaped pattern silently stays in the prose scan.
 */
export function proseSafeDenyPatterns(patterns) {
    return patterns.filter((p) => !SUBJECT_ONLY_DENY_SOURCES.has(p.source.replace(/\\\//g, '/')));
}
/**
 * The ONE deny scan. Builds the haystack, applies the prose scope, and returns
 * the first matching pattern (or null).
 *
 * Both enforcement points MUST call this instead of assembling the haystack and
 * calling `matchRule` themselves: a hand-built scan at one site silently
 * diverges from the other, which is exactly how the v0.14.4 parity bug and the
 * v0.15.1 prose-scope miss happened (the gate scanned prose with the full
 * pattern list while `classifyBand` filtered it).
 */
export function scanDenyBand(toolName, args, denyPatterns) {
    const commandText = bashCommandOf(args);
    const haystack = denyHaystackFor(toolName, args, commandText);
    const effective = isProseCarrier(toolName, commandText)
        ? proseSafeDenyPatterns(denyPatterns)
        : denyPatterns;
    return matchRule(effective, haystack);
}
/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export function classifyBand(toolName, reason, args, denyPatterns, allowGlobs, readOnlyTools) {
    const commandText = bashCommandOf(args);
    const haystack = denyHaystackFor(toolName, args, commandText);
    // 1. Deny band (regex hard-reject) — one shared scan; on a prose-bearing call
    //    subject-only built-in patterns are skipped so that *mentioning* a
    //    sensitive thing is not treated as *handling* it (v0.15.1).
    const denyHit = scanDenyBand(toolName, args, denyPatterns);
    if (denyHit !== null) {
        return { action: 'deny', tier: 'deny', detail: `matched deny pattern /${denyHit}/` };
    }
    // 2. Deletion guard
    if (commandText) {
        const delHit = matchDeletion(`${reason ?? ''}\n${commandText}`);
        if (delHit !== null) {
            return {
                action: 'deny',
                tier: 'deletionGuard',
                detail: 'permanent deletion forbidden — use `trash <file>` instead (moves to Recycle Bin)',
            };
        }
    }
    // 3. Allow band (prefix glob, non-composite commands only)
    if (allowGlobs.length > 0 && commandText && !isCompositeShell(commandText)) {
        const allowHit = matchAllow(allowGlobs, commandText);
        if (allowHit !== null) {
            return { action: 'allow', tier: 'allow', detail: `matched allow glob /${allowHit}/` };
        }
    }
    // 4. Read-only tools default-allow (unless deny matched above)
    if (isReadOnlyTool(toolName, readOnlyTools)) {
        return { action: 'allow', tier: 'readOnlyTool', detail: toolName };
    }
    // 5. Everything else → classifier
    return { action: 'classify', tier: 'classify', detail: 'no deterministic band matched' };
}
