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
/** Expand `~` and `${HOME}`/`$HOME` at the front of a path (for `cd ~` and `git -C ~`).
 * Left as-is when `HOME` is empty. */
export declare function expandHome(p: string): string;
/** Compile a rule string into a case-insensitive RegExp. */
export declare function compileRegex(rule: string): RegExp;
/** Whether `haystack` matches any regex in the list. Returns the first hit. */
export declare function matchRule(rules: readonly RegExp[], haystack: string): string | null;
/** Compile a prefix-glob into an anchored RegExp (leading/trailing * wildcards). */
export declare function compileGlob(pattern: string): RegExp;
/** Whether `text` matches any compiled glob. */
export declare function matchAllow(globs: RegExp[], text: string): string | null;
/** Extract the command field from tool arguments (string or object). */
export declare function bashCommandOf(args: unknown): string;
/** Detect shell metacharacters that indicate a composite command.
 * Quote-aware: control characters inside quotes are literal — a quoted
 * filename like "GRF 2026 (copy).docx" is NOT a subshell — and only an
 * unquoted `; & | > \` $ ( )` marks the command as composite. */
export declare function isCompositeShell(text: string): boolean;
/** Quote-aware shell tokenization (no metachar expansion, no env substitution). */
export declare function tokenizeShell(cmd: string): string[];
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
export declare function bashWriteDestinations(cmd: string, cwd?: string): string[];
/** Whether `text` contains a permanent-deletion command. */
export declare function matchDeletion(text: string): string | null;
/** Whether `text` is a read-only tool name. */
export declare function isReadOnlyTool(toolName: string, readOnlyTools: readonly string[]): boolean;
/** Whether the tool name is a file-path tool (targets are paths, not commands). */
export declare function isFileTool(name: string): boolean;
/** Collect candidate file/dir path strings from a file-tool call's args. */
export declare function collectPaths(args: unknown): string[];
/** Collect only definitive filesystem-path argument values (no search patterns).
 * Used for deny scanning so a grep/glob search term is not mistaken for a target. */
export declare function collectDenyPaths(args: unknown): string[];
/**
 * Deny-scan haystack shared by BOTH enforcement points (v0.14.4, review #1).
 * File tools scan only their TARGET PATHS — document content must NOT be
 * scanned (v0.11.1 design: mentioning a sensitive filename in prose is not a
 * leak). Bash scans the command text. Keeps the gate and the approval path
 * identical so the hard-deny band can never diverge between the two.
 */
export declare function denyHaystackFor(toolName: string, args: unknown, commandText: string): string;
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
export declare const SUBJECT_ONLY_DENY_SOURCES: ReadonlySet<string>;
/** Whether this call's arguments are prose (no command text, not a file tool). */
export declare function isProseCarrier(toolName: string, commandText: string): boolean;
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
export declare function proseSafeDenyPatterns(patterns: readonly RegExp[]): RegExp[];
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
export declare function scanDenyBand(toolName: string, args: unknown, denyPatterns: readonly RegExp[]): string | null;
/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export declare function classifyBand(toolName: string, reason: string, args: unknown, denyPatterns: RegExp[], allowGlobs: RegExp[], readOnlyTools: readonly string[]): {
    action: 'allow' | 'deny' | 'classify';
    tier: string;
    detail: string;
};
