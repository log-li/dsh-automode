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
/** Hard-reject regex patterns (deterministic, never overrideable). */
export declare const DEFAULT_DENY: readonly ["curl\\s+[^|]*\\|\\s*(?:ba)?sh", "wget\\s+[^|]*\\|\\s*(?:ba)?sh", "-----BEGIN[A-Z ]*PRIVATE KEY-----", "AWS_SECRET", "authorized_keys", "\\.aws/credentials", "(?:^|[:\\s;&|(\"'])(?:trash|mv)\\s+/(?:etc|usr|bin|sbin|var|System|Library|private/etc)(?:/|\\s|$)", "docker\\s+(volume\\s+rm|system\\s+prune|container\\s+prune)", "(?<![a-zA-Z0-9?.])\\.ssh/", "(?<![a-zA-Z0-9?.])\\.zshrc", "(?<![a-zA-Z0-9?.])\\.bashrc", "(?<![a-zA-Z0-9?.])\\.bash_profile", "(?<![a-zA-Z0-9?.])\\.profile\\b", "(?<![a-zA-Z0-9?.])\\.claude/settings", "id_rsa|id_ed25519", "(?<![a-zA-Z0-9?.])\\.pem\\b", "(?<![a-zA-Z0-9?.])\\.env\\b", "(?<![a-zA-Z0-9])credentials\\b"];
/** Zero-LLM allow patterns (prefix globs). */
export declare const DEFAULT_ALLOW: readonly ["trash *", "echo *", "git status", "git status *", "git log*", "git diff*", "git show*", "wc *", "head *", "tail *", "sort *", "uniq *", "date*", "which *", "ps *", "df *", "du *", "mkdir *", "ls*", "pip show *", "pip list *", "npm view *", "tasklist *", "brew list *", "brew info *", "brew --prefix", "unzip -l *", "tar xzf *", "code *"];
/** Read-only tools that skip the classifier (unless deny matched). */
export declare const DEFAULT_READ_ONLY_TOOLS: readonly ["read", "glob", "grep", "list", "search"];
/** Soft-deny prose rules fed to the classifier (pi-automode inspired). */
export declare const DEFAULT_SOFT_DENY: readonly ["Force pushing, deleting remote branches, or rewriting remote history", "Downloading and executing external code (curl | bash, wget | sh)", "Production deploys, database migrations, or infrastructure changes", "Deleting or overwriting pre-existing files the user did not name", "Sending repository contents, secrets, or credentials to external endpoints", "Changing security settings, authentication, or access controls"];
/** Soft-allow prose rules (exceptions to soft_deny). */
export declare const DEFAULT_SOFT_ALLOW: readonly ["Read-only operations: inspecting files, listing, searching, GET requests", "Local development inside the working tree: creating, editing, building, testing", "Installing dependencies already declared in package manifests", "Standard git operations: commit, status, diff, log, branch"];
/** Environment facts for the classifier. */
export declare const DEFAULT_ENVIRONMENT: readonly ["The working directory and its git repository are trusted"];
/** Curated full-trust external directories (CC Edit(...) style). */
export declare const DEFAULT_ALLOW_PATHS: readonly string[];
declare const DEFAULTS_MAP: {
    readonly deny: readonly ["curl\\s+[^|]*\\|\\s*(?:ba)?sh", "wget\\s+[^|]*\\|\\s*(?:ba)?sh", "-----BEGIN[A-Z ]*PRIVATE KEY-----", "AWS_SECRET", "authorized_keys", "\\.aws/credentials", "(?:^|[:\\s;&|(\"'])(?:trash|mv)\\s+/(?:etc|usr|bin|sbin|var|System|Library|private/etc)(?:/|\\s|$)", "docker\\s+(volume\\s+rm|system\\s+prune|container\\s+prune)", "(?<![a-zA-Z0-9?.])\\.ssh/", "(?<![a-zA-Z0-9?.])\\.zshrc", "(?<![a-zA-Z0-9?.])\\.bashrc", "(?<![a-zA-Z0-9?.])\\.bash_profile", "(?<![a-zA-Z0-9?.])\\.profile\\b", "(?<![a-zA-Z0-9?.])\\.claude/settings", "id_rsa|id_ed25519", "(?<![a-zA-Z0-9?.])\\.pem\\b", "(?<![a-zA-Z0-9?.])\\.env\\b", "(?<![a-zA-Z0-9])credentials\\b"];
    readonly allow: readonly ["trash *", "echo *", "git status", "git status *", "git log*", "git diff*", "git show*", "wc *", "head *", "tail *", "sort *", "uniq *", "date*", "which *", "ps *", "df *", "du *", "mkdir *", "ls*", "pip show *", "pip list *", "npm view *", "tasklist *", "brew list *", "brew info *", "brew --prefix", "unzip -l *", "tar xzf *", "code *"];
    readonly soft_deny: readonly ["Force pushing, deleting remote branches, or rewriting remote history", "Downloading and executing external code (curl | bash, wget | sh)", "Production deploys, database migrations, or infrastructure changes", "Deleting or overwriting pre-existing files the user did not name", "Sending repository contents, secrets, or credentials to external endpoints", "Changing security settings, authentication, or access controls"];
    readonly soft_allow: readonly ["Read-only operations: inspecting files, listing, searching, GET requests", "Local development inside the working tree: creating, editing, building, testing", "Installing dependencies already declared in package manifests", "Standard git operations: commit, status, diff, log, branch"];
    readonly environment: readonly ["The working directory and its git repository are trusted"];
};
type DefaultsKey = keyof typeof DEFAULTS_MAP;
/**
 * Expand `$defaults` tokens in an array: replace each `"$defaults"` with
 * the built-in entries for that key. If no `$defaults` is present, the
 * array is returned as-is (user takes full ownership).
 */
export declare function expandDefaults(arr: readonly string[], key: DefaultsKey): string[];
export declare const Config: z<Schemastery.ObjectS<{
    /** Regex patterns that hard-reject. First match wins. */
    deny: z<string[], string[]>;
    /** Prefix-glob patterns that zero-LLM approve (after deny). */
    allow: z<string[], string[]>;
    /** Read-only tools that default-allow (unless deny matched). */
    readOnlyTools: z<string[], string[]>;
    /** Curated full-trust external directories. */
    allowPaths: z<string[], string[]>;
    /** Allow writes inside the working directory without classifier. */
    allowInsideWorkingDirectory: z<boolean, boolean>;
    classifier: z<Schemastery.ObjectS<{
        /** Provider route; empty = follow the session. */
        provider: z<string, string>;
        /** Model id; empty = follow the session. */
        model: z<string, string>;
        /** Trailing transcript messages for the classifier. */
        maxTranscriptMessages: z<number, number>;
        /** Output token budget. */
        maxTokens: z<number, number>;
        /** Sampling temperature. */
        temperature: z<number, number>;
        /** Reasoning level hint (off/low/medium/high); 'off' disables reasoning. */
        reasoningLevel: z<string, string>;
        /** How many recent direct user messages feed the intent block (CC-style). */
        maxIntentMessages: z<number, number>;
    }>, Schemastery.ObjectT<{
        /** Provider route; empty = follow the session. */
        provider: z<string, string>;
        /** Model id; empty = follow the session. */
        model: z<string, string>;
        /** Trailing transcript messages for the classifier. */
        maxTranscriptMessages: z<number, number>;
        /** Output token budget. */
        maxTokens: z<number, number>;
        /** Sampling temperature. */
        temperature: z<number, number>;
        /** Reasoning level hint (off/low/medium/high); 'off' disables reasoning. */
        reasoningLevel: z<string, string>;
        /** How many recent direct user messages feed the intent block (CC-style). */
        maxIntentMessages: z<number, number>;
    }>>;
    rules: z<Schemastery.ObjectS<{
        deny: z<string[], string[]>;
        allow: z<string[], string[]>;
        environment: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        deny: z<string[], string[]>;
        allow: z<string[], string[]>;
        environment: z<string[], string[]>;
    }>>;
    /** Fail-closed on classifier failure. */
    failClosed: z<boolean, boolean>;
    /** Enable the pre-execute gate. */
    preExecuteGate: z<boolean, boolean>;
    /** Classifier call timeout (ms). */
    timeoutMs: z<number, number>;
    /** Context budget for task-alignment input. */
    classifyContextChars: z<number, number>;
    /** Max args characters for signature. */
    maxArgsChars: z<number, number>;
    /** Consecutive DENY count to trip the breaker. */
    breakerConsecutive: z<number, number>;
    /** Total DENY count to trip the breaker. */
    breakerTotal: z<number, number>;
}>, Schemastery.ObjectT<{
    /** Regex patterns that hard-reject. First match wins. */
    deny: z<string[], string[]>;
    /** Prefix-glob patterns that zero-LLM approve (after deny). */
    allow: z<string[], string[]>;
    /** Read-only tools that default-allow (unless deny matched). */
    readOnlyTools: z<string[], string[]>;
    /** Curated full-trust external directories. */
    allowPaths: z<string[], string[]>;
    /** Allow writes inside the working directory without classifier. */
    allowInsideWorkingDirectory: z<boolean, boolean>;
    classifier: z<Schemastery.ObjectS<{
        /** Provider route; empty = follow the session. */
        provider: z<string, string>;
        /** Model id; empty = follow the session. */
        model: z<string, string>;
        /** Trailing transcript messages for the classifier. */
        maxTranscriptMessages: z<number, number>;
        /** Output token budget. */
        maxTokens: z<number, number>;
        /** Sampling temperature. */
        temperature: z<number, number>;
        /** Reasoning level hint (off/low/medium/high); 'off' disables reasoning. */
        reasoningLevel: z<string, string>;
        /** How many recent direct user messages feed the intent block (CC-style). */
        maxIntentMessages: z<number, number>;
    }>, Schemastery.ObjectT<{
        /** Provider route; empty = follow the session. */
        provider: z<string, string>;
        /** Model id; empty = follow the session. */
        model: z<string, string>;
        /** Trailing transcript messages for the classifier. */
        maxTranscriptMessages: z<number, number>;
        /** Output token budget. */
        maxTokens: z<number, number>;
        /** Sampling temperature. */
        temperature: z<number, number>;
        /** Reasoning level hint (off/low/medium/high); 'off' disables reasoning. */
        reasoningLevel: z<string, string>;
        /** How many recent direct user messages feed the intent block (CC-style). */
        maxIntentMessages: z<number, number>;
    }>>;
    rules: z<Schemastery.ObjectS<{
        deny: z<string[], string[]>;
        allow: z<string[], string[]>;
        environment: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        deny: z<string[], string[]>;
        allow: z<string[], string[]>;
        environment: z<string[], string[]>;
    }>>;
    /** Fail-closed on classifier failure. */
    failClosed: z<boolean, boolean>;
    /** Enable the pre-execute gate. */
    preExecuteGate: z<boolean, boolean>;
    /** Classifier call timeout (ms). */
    timeoutMs: z<number, number>;
    /** Context budget for task-alignment input. */
    classifyContextChars: z<number, number>;
    /** Max args characters for signature. */
    maxArgsChars: z<number, number>;
    /** Consecutive DENY count to trip the breaker. */
    breakerConsecutive: z<number, number>;
    /** Total DENY count to trip the breaker. */
    breakerTotal: z<number, number>;
}>>;
/** The normalized output type of the config schema. */
export type ConfigType = typeof Config extends Schema<any, infer T> ? T : never;
export {};
