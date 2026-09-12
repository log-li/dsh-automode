export interface CachedVerdict {
    decision: 'ALLOW' | 'DENY';
    at: number;
}
/**
 * Deterministic string hash (djb2 → base36). Not for security — used only to
 * fold the user's recent direct instructions into a cache signature so that
 * a NEW explicit user authorization changes the signature and forces the
 * classifier to re-run (a cached DENY must not swallow a user grant).
 */
export declare function hashString(text: string): string;
/**
 * The cache-key subject for one tool call's arguments.
 *
 * - `args.command` (bash) → the command text, verbatim (legacy behavior).
 * - argument objects with path fields (file tools) → `reason |dirs:<sorted,
 *   deduped target dirnames>` (v0.14.1). Same directory shares a verdict;
 *   different directories never collide, even with identical justification
 *   text. `dirname` is applied without realpath — a symlink / `..` variant of
 *   the same directory simply re-classifies once (safe side).
 * - anything else (PROSE-BEARING tools: a dispatched subagent, a workflow
 *   script, any text-carrying tool) → `reason |args:<hash of the args text>`
 *   (v0.15.2). The classifier now SEES those arguments (`argsPreviewOf`), so
 *   the key must describe them too: before this, two dispatches that shared a
 *   justification but carried different payloads produced ONE signature, and
 *   a cached ALLOW for the benign payload was handed to the hostile one with
 *   no model involved (review S1). The hash keeps the key short so a long
 *   model-controlled `reason` cannot truncate the subject out under maxChars.
 */
export declare function toolArgsKey(args: unknown, reason: string): string;
export declare class VerdictCache {
    private store;
    /**
     * Build a stable signature for a classifier call.
     *
     * `intentHash` (the hash of the user's recent direct instructions, see
     * `hashString`) is optional: when provided it becomes part of the key, so
     * a new human authorization invalidates a previously cached verdict and the
     * classifier is re-run with the fresh intent. Without it the signature is
     * exactly the legacy tool|command form.
     *
     * Key subject = `args.command` when present (bash); for argument objects
     * WITHOUT a `command` (file tools) it is `reason` plus the sorted, deduped
     * TARGET DIRECTORIES of `file_path/path/dir/root` (v0.14.1). No path fields
     * → legacy `tool|reason` form, unchanged behavior.
     */
    static sig(toolName: string, reason: string, args: unknown, maxChars?: number, intentHash?: string): string;
    get(sessionId: string, sig: string): 'ALLOW' | 'DENY' | null;
    put(sessionId: string, sig: string, decision: 'ALLOW' | 'DENY' | null): void;
}
