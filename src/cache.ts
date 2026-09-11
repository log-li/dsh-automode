/**
 * Verdict cache — shared between the pre-execute gate and the approval path.
 *
 * Keyed per session by a stable signature (tool + reason + args head).
 * TTL-bounded and size-capped; only positive/negative CLASSIFIER verdicts
 * live here (deterministic bands re-run cheaply and must never be cached).
 *
 * v0.14.1 (directory granularity): file tools (write/edit/…) carry no
 * `command`, so their key used to collapse to `tool | justification | intent`
 * — write probes A→B (same justification, different file) and D→E (different
 * directory) both hit the cache, letting a verdict for one target apply to
 * another the classifier never saw. The key now folds the TARGET
 * DIRECTORIES (`dirname` of `file_path/path/dir/root`, sorted, deduped) of
 * file-tool args in as well: same directory shares (batch writes in one dir
 * are the same safety profile — that is the user-approved granularity),
 * different directories never share. Sensitive FILENAMES stay the deny band's
 * job (`collectDenyPaths` re-checks every call, cache-independent).
 *
 * Ported from dsh-auto-mode v0.4.1 lib/index.js.
 */
import { dirname } from 'node:path';

export interface CachedVerdict {
  decision: 'ALLOW' | 'DENY';
  at: number;
}

const VERDICT_TTL_MS = 300_000; // 5 minutes
const MAX_ENTRIES_PER_SESSION = 50;

/**
 * Deterministic string hash (djb2 → base36). Not for security — used only to
 * fold the user's recent direct instructions into a cache signature so that
 * a NEW explicit user authorization changes the signature and forces the
 * classifier to re-run (a cached DENY must not swallow a user grant).
 */
export function hashString(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Path fields the sig recognizer treats as file-tool targets. */
const TARGET_PATH_KEYS = ['file_path', 'path', 'dir', 'root'] as const;

/**
 * The cache-key subject for one tool call's arguments.
 *
 * - `args.command` (bash) → the command text, verbatim (legacy behavior).
 * - argument objects with path fields (file tools) → `reason |dirs:<sorted,
 *   deduped target dirnames>` (v0.14.1). Same directory shares a verdict;
 *   different directories never collide, even with identical justification
 *   text. `dirname` is applied without realpath — a symlink / `..` variant of
 *   the same directory simply re-classifies once (safe side).
 * - anything else → the reason text (legacy fallback).
 */
export function toolArgsKey(args: unknown, reason: string): string {
  if (typeof args === 'object' && args !== null) {
    const rec = args as Record<string, unknown>;
    if (typeof rec.command === 'string' && rec.command) return rec.command;
    const dirs = new Set<string>();
    for (const key of TARGET_PATH_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && v) dirs.add(dirname(v));
      else if (Array.isArray(v)) {
        for (const item of v) if (typeof item === 'string' && item) dirs.add(dirname(item));
      }
    }
    if (dirs.size > 0) {
      // Hashed (short, fixed-length) so a long model-controlled `reason`
      // cannot truncate the dirs out of the key under maxArgsChars and
      // resurrect same-reason/different-dir sharing (v0.14.4 re-review #1).
      return `${String(reason ?? '')} |dirs:${hashString(JSON.stringify([...dirs].sort()))}`;
    }
  }
  return String(reason ?? '');
}

export class VerdictCache {
  private store = new Map<string, Map<string, CachedVerdict>>();

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
  static sig(toolName: string, reason: string, args: unknown, maxChars = 200, intentHash = ''): string {
    const cmd = toolArgsKey(args, reason);
    const base = `${toolName}|${cmd.slice(0, maxChars).toLowerCase()}`;
    return intentHash ? `${base}|intent:${intentHash}` : base;
  }

  get(sessionId: string, sig: string): 'ALLOW' | 'DENY' | null {
    const m = this.store.get(sessionId);
    if (!m) return null;
    const hit = m.get(sig);
    if (!hit) return null;
    if (Date.now() - hit.at > VERDICT_TTL_MS) {
      m.delete(sig);
      return null;
    }
    return hit.decision;
  }

  put(sessionId: string, sig: string, decision: 'ALLOW' | 'DENY' | null): void {
    if (decision === null) return; // FAILs are never cached — retry next time
    let m = this.store.get(sessionId);
    if (!m) {
      m = new Map();
      this.store.set(sessionId, m);
    }
    m.set(sig, { decision, at: Date.now() });
    if (m.size > MAX_ENTRIES_PER_SESSION) {
      m.delete(m.keys().next().value!);
    }
  }
}
