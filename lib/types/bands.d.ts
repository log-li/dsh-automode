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
export declare function matchRule(rules: RegExp[], haystack: string): string | null;
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
/** Check whether an action matches a deny pattern, an allow pattern, or neither. */
export declare function classifyBand(toolName: string, reason: string, args: unknown, denyPatterns: RegExp[], allowGlobs: RegExp[], readOnlyTools: readonly string[]): {
    action: 'allow' | 'deny' | 'classify';
    tier: string;
    detail: string;
};
