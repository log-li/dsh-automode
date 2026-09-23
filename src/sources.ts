/**
 * Producer-owned message source for everything this plugin injects.
 *
 * DSH session format v4 (`dsh >= 0.1.7-alpha.1`) retired the catch-all
 * `{ kind: 'plugin', plugin: '…' }` source: v4 admission rejects it outright
 * (`format v4 message requires a producer-owned source kind`) across every
 * durable message slot, including `agent/inbox/spliced` — the event
 * `agent.inject()` writes. Each producer now declares its own kind, so this
 * plugin declares `plugin:auto-mode`.
 *
 * The value is deliberately format-agnostic, so no version probing is needed:
 *   - format v3 hosts accept any non-empty kind (native row admission and
 *     payload semantics both only require a string);
 *   - the released v3 → v4 migration rewrites historical
 *     `{ kind: 'plugin', plugin: 'auto-mode' }` records to exactly this kind
 *     and passes non-`plugin` kinds through unchanged, so old and new log
 *     records converge on one identity.
 *
 * See spec §版本支持声明 → 「注入消息的来源标识」.
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:auto-mode': { kind: 'plugin:auto-mode' };
  }
}

/** The one source every auto-mode injection carries. */
export const AUTO_MODE_SOURCE = { kind: 'plugin:auto-mode' } as const;

/** Retired catch-all kind: v4 refuses durable messages that still use it. */
export const RETIRED_PLUGIN_KIND = 'plugin';
