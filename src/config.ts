/**
 * Plugin configuration schema (v0.5.0).
 *
 * Merges dsh-auto-mode v0.4.1 deterministic bands with Nuo-cl's native
 * preset integration and pi-automode's $defaults mechanism.
 *
 * Rule hierarchy:
 *   1. deny (regex) — hard-reject, evaluated first, never overridable
 *   2. allow (prefix glob) — zero-LLM approve, evaluated after deny
 *   3. rules.deny/allow/environment (prose) — fed to the classifier
 *
 * The `$defaults` token in any rules.* array expands to built-in entries
 * for that section. Users can ["$defaults", "my rule"] to keep defaults
 * while adding custom rules.
 */
import z from '@deepseek-ai/schemastery';
import type Schema from '@deepseek-ai/schemastery';

// ---- $defaults built-in rules ----

/** Hard-reject regex patterns (deterministic, never overrideable). */
export const DEFAULT_DENY = [
  // Executing downloaded code
  'curl\\s+[^|]*\\|\\s*(?:ba)?sh',
  'wget\\s+[^|]*\\|\\s*(?:ba)?sh',
  // Key material written inline in the operation itself (the value is IN the
  // command, so the command is the leak). The bare phrase "PRIVATE KEY" is no
  // longer matched: it only fired on prose that merely discussed keys (v0.15.1).
  '-----BEGIN[A-Z ]*PRIVATE KEY-----',
  'AWS_SECRET',
  // Sensitive targets / paths (lookbehind avoids false positives on property
  // access). These name a subject rather than an operation, so prose-bearing
  // tools skip them — see SUBJECT_ONLY_DENY_SOURCES in bands.ts.
  'authorized_keys',
  '\\.aws/credentials',
  // System locations
  '(?:^|[:\\s;&|("\'])(?:trash|mv)\\s+/(?:etc|usr|bin|sbin|var|System|Library|private/etc)(?:/|\\s|$)',
  // Docker/K8s state
  'docker\\s+(volume\\s+rm|system\\s+prune|container\\s+prune)',
  '(?<![a-zA-Z0-9?.])\\.ssh/',
  '(?<![a-zA-Z0-9?.])\\.zshrc',
  '(?<![a-zA-Z0-9?.])\\.bashrc',
  '(?<![a-zA-Z0-9?.])\\.bash_profile',
  '(?<![a-zA-Z0-9?.])\\.profile\\b',
  '(?<![a-zA-Z0-9?.])\\.claude/settings',
  'id_rsa|id_ed25519',
  '(?<![a-zA-Z0-9?.])\\.pem\\b',
  '(?<![a-zA-Z0-9?.])\\.env\\b',
  // Credential stores. The token match is deliberately BROAD here: the v0.15.1
  // attempt to narrow it to store *filenames* silently lost `~/.git-credentials`
  // (git's plaintext helper store), `~/.config/gcloud/credentials` and a bare
  // `credentials` argument — and a non-escalated bash call never reaches the
  // classifier, so nothing else would have caught them (v0.15.1 revert).
  // Prose false positives are handled by the prose SCOPE, not by narrowing the
  // pattern: this source is listed in SUBJECT_ONLY_DENY_SOURCES (bands.ts), so
  // prose-bearing tools skip it while bash command text keeps full coverage.
  '(?<![a-zA-Z0-9])credentials\\b',
] as const;

/** Zero-LLM allow patterns (prefix globs). */
export const DEFAULT_ALLOW = [
  'trash *',
  'echo *',
  'git status',
  'git status *',
  'git log*',
  'git diff*',
  'git show*',
  'wc *',
  'head *',
  'tail *',
  'sort *',
  'uniq *',
  'date*',
  'which *',
  'ps *',
  'df *',
  'du *',
  'mkdir *',
  'ls*',
  'pip show *',
  'pip list *',
  'npm view *',
  'tasklist *',
  'brew list *',
  'brew info *',
  'brew --prefix',
  'unzip -l *',
  'tar xzf *',
  'code *',
] as const;

/** Read-only tools that skip the classifier (unless deny matched). */
export const DEFAULT_READ_ONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'list',
  'search',
] as const;

/** Soft-deny prose rules fed to the classifier (pi-automode inspired). */
export const DEFAULT_SOFT_DENY = [
  'Force pushing, deleting remote branches, or rewriting remote history',
  'Downloading and executing external code (curl | bash, wget | sh)',
  'Production deploys, database migrations, or infrastructure changes',
  'Deleting or overwriting pre-existing files the user did not name',
  'Sending repository contents, secrets, or credentials to external endpoints',
  'Changing security settings, authentication, or access controls',
] as const;

/** Soft-allow prose rules (exceptions to soft_deny). */
export const DEFAULT_SOFT_ALLOW = [
  'Read-only operations: inspecting files, listing, searching, GET requests',
  'Local development inside the working tree: creating, editing, building, testing',
  'Installing dependencies already declared in package manifests',
  'Standard git operations: commit, status, diff, log, branch',
] as const;

/** Environment facts for the classifier. */
export const DEFAULT_ENVIRONMENT = [
  'The working directory and its git repository are trusted',
] as const;

/** Curated full-trust external directories (CC Edit(...) style). */
export const DEFAULT_ALLOW_PATHS: readonly string[] = [];

// ---- $defaults expansion ----

const DEFAULTS_MAP = {
  deny: DEFAULT_DENY,
  allow: DEFAULT_ALLOW,
  soft_deny: DEFAULT_SOFT_DENY,
  soft_allow: DEFAULT_SOFT_ALLOW,
  environment: DEFAULT_ENVIRONMENT,
} as const;

type DefaultsKey = keyof typeof DEFAULTS_MAP;

/**
 * Expand `$defaults` tokens in an array: replace each `"$defaults"` with
 * the built-in entries for that key. If no `$defaults` is present, the
 * array is returned as-is (user takes full ownership).
 */
export function expandDefaults(
  arr: readonly string[],
  key: DefaultsKey,
): string[] {
  const defaults = DEFAULTS_MAP[key] as readonly string[];
  const result: string[] = [];
  let hasDefaults = false;
  for (const item of arr) {
    if (item === '$defaults') {
      result.push(...defaults);
      hasDefaults = true;
    } else {
      result.push(item);
    }
  }
  return hasDefaults ? result : [...arr];
}

// ---- Config schema ----

export const Config = z.object({
  // --- Hard boundary (deterministic, never goes to classifier) ---

  /** Regex patterns that hard-reject. First match wins. */
  deny: z.array(z.string()).default([...DEFAULT_DENY]),

  /** Prefix-glob patterns that zero-LLM approve (after deny). */
  allow: z.array(z.string()).default([...DEFAULT_ALLOW]),

  /** Read-only tools that default-allow (unless deny matched). */
  readOnlyTools: z.array(z.string()).default([...DEFAULT_READ_ONLY_TOOLS]),

  /** Curated full-trust external directories. */
  allowPaths: z.array(z.string()).default([...DEFAULT_ALLOW_PATHS]),

  /** Allow writes inside the working directory without classifier. */
  allowInsideWorkingDirectory: z.boolean().default(true),

  // --- Classifier ---

  classifier: z.object({
    /** Provider route; empty = follow the session. */
    provider: z.string().default(''),
    /** Model id; empty = follow the session. */
    model: z.string().default(''),
    /** Trailing transcript messages for the classifier. */
    maxTranscriptMessages: z.number().default(40),
    /** Output token budget. */
    maxTokens: z.number().default(2048),
    /** Sampling temperature. */
    temperature: z.number().default(0),
    /** Reasoning level hint (off/low/medium/high); 'off' disables reasoning. */
    reasoningLevel: z.string().default('off'),
    /** How many recent direct user messages feed the intent block (CC-style). */
    maxIntentMessages: z.number().default(6).min(1),
  }),

  // --- Prose rules (fed to classifier) ---

  rules: z.object({
    deny: z.array(z.string()).default(['$defaults']),
    allow: z.array(z.string()).default(['$defaults']),
    environment: z.array(z.string()).default(['$defaults']),
  }),

  // --- Runtime ---

  /** Fail-closed on classifier failure. */
  failClosed: z.boolean().default(true),
  /** Enable the pre-execute gate. */
  preExecuteGate: z.boolean().default(true),
  /** Classifier call timeout (ms). */
  timeoutMs: z.number().default(45000).min(1000),
  /** Context budget for task-alignment input. */
  classifyContextChars: z.number().default(6000).min(500),
  /** Max args characters for signature. */
  maxArgsChars: z.number().default(4000).min(1),
  /** Consecutive DENY count to trip the breaker. */
  breakerConsecutive: z.number().default(3).min(0),
  /** Total DENY count to trip the breaker. */
  breakerTotal: z.number().default(20).min(0),
});

/** The normalized output type of the config schema. */
export type ConfigType = typeof Config extends Schema<any, infer T> ? T : never;
