/**
 * Managed Claude Code → Codex routing prompt (fork feature f5).
 *
 * This is shared by the server and settings preview. Keeping one renderer is
 * what makes the UI preview byte-identical to the text attached to a session.
 */
import {
  composeSystemPromptText,
  DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
  type ClaudeCodexModelPreferences,
  type ClaudeCodexRoutingSettings,
  type ClaudeCodexSecondOpinionMode,
  type ClaudeCodexTaskRoute,
} from "@t3tools/contracts";

export const DEFAULT_CLAUDE_CODEX_MODEL = "gpt-5.6-sol";

export function effectiveClaudeCodexModel(model: string | undefined): string {
  return model?.trim() || DEFAULT_CLAUDE_CODEX_MODEL;
}

export function buildClaudeCodexBridgePrompt(model: string): string {
  const selectedModel = effectiveClaudeCodexModel(model);
  return `# Claude Code → Codex bridge (managed by T3 Code)

This Claude Code session has a Codex bridge. The Claude \`haiku\` subagent slot is remapped to the Codex model \`${selectedModel}\`.

Runtime rules:
- \`Agent(model: "haiku")\` and Workflow agents configured with \`model: "haiku"\` run \`${selectedModel}\` through the user's Codex account. They do not run Anthropic Haiku in this session.
- The Agent/Workflow model field still accepts Claude Code's model aliases. Never pass a raw GPT/Codex model id to that field; use \`haiku\` to reach the configured Codex model.
- Only the \`haiku\` alias is remapped. An explicit Anthropic Haiku model id such as \`claude-haiku-…\` remains real Anthropic Haiku.
- Prefer the remapped Haiku slot for delegated Codex work: it preserves native agent streaming, task cards, permissions, and transcripts.
- Give every delegated Codex agent a self-contained prompt with the relevant files, constraints, expected result, and verification steps.
- If a remapped agent fails with a bridge, connection, or HTTP 502 error, retry the work with an available Claude model and report that the Codex bridge was unavailable. Do not silently claim that Codex completed the task.

Treat the remapping above as a runtime fact for this session, not as a suggestion.`;
}

type TaskPreferenceKey = Exclude<
  keyof ClaudeCodexModelPreferences,
  "claudeSubagentModel" | "claudeSubagentModels" | "secondOpinion"
>;

const TASK_PREFERENCES: ReadonlyArray<{
  readonly key: TaskPreferenceKey;
  readonly label: string;
  readonly scope: string;
}> = [
  {
    key: "exploration",
    label: "Exploration and research",
    scope: "codebase mapping, evidence gathering, and independent investigation",
  },
  {
    key: "implementation",
    label: "Implementation and refactors",
    scope: "clear-spec code changes, refactors, migrations, and mechanical edits",
  },
  {
    key: "verification",
    label: "Tests and verification",
    scope: "running checks, reproducing defects, and verifying concrete claims",
  },
  {
    key: "planning",
    label: "Planning and architecture",
    scope: "plans, architecture decisions, tradeoffs, and ambiguous technical direction",
  },
  {
    key: "design",
    label: "UI, UX, and product design",
    scope: "interaction design, visual decisions, user-facing copy, and product judgment",
  },
  {
    key: "review",
    label: "Review and final analysis",
    scope: "code review, risk assessment, synthesis, and final conclusions",
  },
];

function claudeModelForTask(
  preferences: ClaudeCodexModelPreferences,
  task: TaskPreferenceKey,
): ClaudeCodexModelPreferences["claudeSubagentModel"] {
  return preferences.claudeSubagentModels[task] ?? preferences.claudeSubagentModel;
}

function taskPreferenceInstruction(
  label: string,
  scope: string,
  route: ClaudeCodexTaskRoute,
  codexModel: string,
  claudeModel: ClaudeCodexModelPreferences["claudeSubagentModel"],
): string {
  if (route === "claude") {
    return `- ${label} → Claude subagent: Delegate ${scope} through \`Agent(model: "${claudeModel}")\` or a Workflow agent using \`model: "${claudeModel}"\` rather than doing the substantial work inline. The main session supplies context, evaluates the result, and owns the synthesis.`;
  }
  if (route === "codex") {
    return `- ${label} → Codex subagent: Delegate ${scope} to \`${codexModel}\` through \`Agent(model: "haiku")\`. The main session supplies context, evaluates the result, and owns the synthesis.`;
  }
  return `- ${label} → best-fit subagent: Use \`Agent(model: "haiku")\` for self-contained, parallelizable, or mechanical parts of ${scope}; use \`Agent(model: "${claudeModel}")\` for interactive, unknown-shape, or judgment-heavy parts. Do not default substantial work to the main loop.`;
}

function secondOpinionInstruction(
  mode: ClaudeCodexSecondOpinionMode,
  codexModel: string,
  preferences: ClaudeCodexModelPreferences,
): string {
  if (mode === "off") {
    return "Second opinions are off. Use the primary subagent route above for one substantive delegated pass, but do not create a competing plan or review solely for another opinion.";
  }
  const planningModel = claudeModelForTask(preferences, "planning");
  const reviewModel = claudeModelForTask(preferences, "review");
  const commonEnding = `Pair the Claude opinion with one \`${codexModel}\` subagent through \`Agent(model: "haiku")\` and run both blind opinions in parallel. Do not show either agent the other's draft. The main session compares both views, adjudicates disagreements, and owns the final artifact. Routine or low-risk work does not need this extra pass.`;
  if (mode === "plans") {
    return `For consequential plans and architecture decisions, run the Claude opinion through \`Agent(model: "${planningModel}")\`. ${commonEnding}`;
  }
  if (mode === "reviews") {
    return `For consequential reviews of real changes, run the Claude opinion through \`Agent(model: "${reviewModel}")\`. ${commonEnding}`;
  }
  if (planningModel === reviewModel) {
    return `For consequential plans, architecture decisions, and reviews of real changes, run the Claude opinion through \`Agent(model: "${planningModel}")\`. ${commonEnding}`;
  }
  return `For consequential plans and architecture decisions, run the Claude opinion through \`Agent(model: "${planningModel}")\`; for consequential reviews of real changes, use \`Agent(model: "${reviewModel}")\`. ${commonEnding}`;
}

export function buildClaudeCodexModelPreferencesPrompt(
  model: string,
  preferences: ClaudeCodexModelPreferences = DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
): string {
  const selectedModel = effectiveClaudeCodexModel(model);
  const ownership = TASK_PREFERENCES.map(({ key, label, scope }) =>
    taskPreferenceInstruction(
      label,
      scope,
      preferences[key],
      selectedModel,
      claudeModelForTask(preferences, key),
    ),
  ).join("\n");
  return `# Model preferences (configured in T3 Code)

The main session stays on its selected Claude model but acts as a thin orchestrator: decompose the request, delegate substantial work, coordinate results, and synthesize the final answer. Do not keep planning, design, implementation, review, or final-analysis work inline merely because it needs judgment; route it to the configured subagent type below. Inline work is for trivial steps, integration between agent results, and the final call.

Subagent routing:
${ownership}

Delegation rules:
- Give every subagent a self-contained prompt with the relevant files, constraints, expected result, and verification steps.
- When independent workstreams exist, run subagents in parallel. Use workflows when several delegated results feed one decision.
- The main session must inspect evidence, resolve conflicts, and synthesize; it must not rubber-stamp a subagent result.
- Avoid delegation theater for genuinely tiny tasks, but prefer delegation whenever a task has a substantive artifact or can be usefully separated.

Second-opinion policy:
${secondOpinionInstruction(preferences.secondOpinion, selectedModel, preferences)}

These preferences guide routing; they do not lower the quality bar. If a delegated result is weak, incomplete, or conflicts with direct evidence, Claude must correct or redo it before presenting a conclusion.`;
}

export function buildManagedClaudeCodexRoutingPrompt(
  model: string,
  preferences: ClaudeCodexModelPreferences = DEFAULT_CLAUDE_CODEX_MODEL_PREFERENCES,
): string {
  return composeSystemPromptText([
    buildClaudeCodexBridgePrompt(model),
    buildClaudeCodexModelPreferencesPrompt(model, preferences),
  ])!;
}

export function isClaudeCodexMainModel(
  mainModel: string | undefined,
  routedModel: string,
): boolean {
  return mainModel?.trim().replace(/\[1m\]$/u, "") === effectiveClaudeCodexModel(routedModel);
}

export function buildClaudeCodexMainSessionPrompt(model: string): string {
  const selectedModel = effectiveClaudeCodexModel(model);
  return `# Codex main session through Claude Code (managed by T3 Code)

This session's main loop runs the Codex model \`${selectedModel}\` through T3 Code's Claude compatibility bridge. It is not running an Anthropic model.

- The configured Claude-versus-Codex task preferences do not apply while Codex is the main model; there is no Claude main loop to assign work to.
- Claude Code's Agent and Workflow model fields still accept Claude aliases, not raw GPT/Codex ids. \`model: "haiku"\` is remapped to \`${selectedModel}\` and is the native way to spawn a Codex subagent.
- Keep the main loop thin: decompose, coordinate, inspect evidence, and synthesize. Delegate substantial implementation, planning, design, review, verification, and independent final-analysis drafts through the Haiku slot instead of doing them inline.
- Run independent subagent workstreams in parallel and give every agent the relevant files, constraints, expected result, and verification steps. Avoid agents only for genuinely trivial steps.
- If the bridge fails with a connection or HTTP 502 error, report that the Codex bridge is unavailable. Do not claim that work completed through another model unless it actually did.`;
}

/** Exact routing text prepended before the ordinary T3 system-prompt rules. */
export function resolveClaudeCodexRoutingPrompt(
  routing: ClaudeCodexRoutingSettings | undefined,
  effectiveModel?: string,
  mainModel?: string,
): string | undefined {
  if (routing?.enabled !== true) return undefined;
  const model = effectiveClaudeCodexModel(effectiveModel ?? routing.model);
  if (isClaudeCodexMainModel(mainModel, model)) {
    return composeSystemPromptText([
      buildClaudeCodexMainSessionPrompt(model),
      routing.additionalInstructions,
    ]);
  }
  const preferenceInstructions =
    routing.promptMode === "none"
      ? undefined
      : routing.promptMode === "custom"
        ? routing.customPrompt
        : buildClaudeCodexModelPreferencesPrompt(model, routing.modelPreferences);
  return composeSystemPromptText([
    buildClaudeCodexBridgePrompt(model),
    preferenceInstructions,
    routing.additionalInstructions,
  ]);
}
