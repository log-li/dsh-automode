export interface PromptInput {
    readonly toolName: string;
    readonly reason?: string;
    readonly allowRules: readonly string[];
    readonly denyRules: readonly string[];
    readonly environmentFacts: readonly string[];
    /** The user's most recent explicit instructions (CC-style intent). */
    readonly userIntent?: string;
    /**
     * The exact bash command text being decided, recovered by callId on the
     * approval path (v0.13.0). The approval payload omits args, so the
     * classifier previously judged from justification prose alone and could pick
     * stale reasons from old context — the recovered command makes the
     * approval-path decision as well-informed as the pre-execute gate's.
     */
    readonly command?: string;
    /**
     * Target paths for FILE tools (v0.14.4, review #2). Escalated file-tool
     * calls carry no `command`, so without this the classifier judged an
     * escalation from the justification prose alone and never saw WHICH file was
     * going to be written. Both enforcement points feed the same paths (gate:
     * targetPaths; approval: recovered args), keeping the verdict inputs aligned.
     */
    readonly paths?: readonly string[];
    /**
     * Truncated arguments preview for tools that carry NEITHER a command nor
     * target paths (v0.15.1, review M2). Without it an escalated prose tool — a
     * dispatched subagent, a workflow script — was judged on the justification
     * ALONE, which is the narration-only defect v0.15.1 set out to remove, still
     * live for every non-bash/non-file tool.
     */
    readonly argsPreview?: string;
}
/**
 * Build the system prompt: safety monitor role + operator rules + decision
 * contract. Model-agnostic: demands terse JSON-only output.
 */
export declare function buildSystemPrompt(input: PromptInput): string;
/**
 * Build the user message: the action being decided.
 */
export declare function buildUserMessage(input: PromptInput, transcript: string): string;
/** Shrink a request to the fields the prompt cares about. */
export declare function promptInputOf(req: {
    toolName: string;
    reason?: string;
    userIntent?: string;
    command?: string;
    paths?: readonly string[];
    argsPreview?: string;
}, allowRules: readonly string[], denyRules: readonly string[], environmentFacts: readonly string[]): PromptInput;
