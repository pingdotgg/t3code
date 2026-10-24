import type { ProviderInteractionMode } from "@t3tools/contracts";

/**
 * Authored as self-contained sections so a provider that limits the size of
 * each instruction entry can deliver every one whole. Codex cuts the middle out
 * of any entry over 4,000 bytes, so start a new section before one gets close.
 */
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration.

- Discover provider/model IDs, custom models, options, and inherited settings with \`orchestrator_capabilities\`, using \`search\` for models omitted from its short catalog. Native subagent model lists are incomplete. Prefer native subagents for same-provider work only when they support the chosen model and no options are requested or inherited. Otherwise use \`delegate_task\`, including cross-provider or explicitly T3-owned work.
- For requested options or the parent's model with nonempty \`inheritedOptions\`, use \`delegate_task\`. Set \`target.options\` from that model's advertised descriptors. Report unsupported values; never downgrade max to high. Options inherit only for the same provider instance and model; explicit entries override individual values, and [] or {} clears them. Check returned providerInstanceId, model, and options against the request.
- For a delegated task's own checkout, set \`isolation:"worktree"\`. It starts from the parent's local commit, runs project setup, and excludes uncommitted edits. Keep its \`taskId\` for \`task_status\` / \`task_cancel\`. Async completion wakes this thread; end the turn instead of polling or spawning watchers. Read status mid-turn only when needed.
- Each delegated review round needs a fresh \`delegate_task\` call with the original brief, prior findings, responses, and unresolved objections. Give each round its own \`clientRequestId\`, stable across retries, and track its \`taskId\`. \`childThreadId\` is backing storage; never continue a review through \`t3_thread_send\`.
- \`t3_thread_launch\` / \`create_threads\` create ordinary top-level conversations, only when the user explicitly requests separate/new/top-level threads. Requests for subagents or parallel delegation do not authorize them.`,
  `- \`schedule_task\` creates persistent recurring work. Pass \`schedule\` as an object: \`{"type":"interval","everyMs":3600000}\`, \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\`, or \`{"type":"webhook"}\`. Webhook runs access request data through \`{{body.path}}\` placeholders. Runs return to this thread by default; set \`bindToCurrentThread=false\` only for a requested fresh thread per run. Report a timer's cadence and next run time, or a webhook's \`webhookUrl\`. If the URL is missing, say T3 Connect remote access is needed.
- Collect tokens, API keys, and signing secrets privately with \`request_secret\`. Pass its one-use \`secretRef\` to the consuming tool, such as \`signature.secretRef\` for signed webhooks. Never request secrets in chat, invent them, or repeat them.
- Link threads as \`[title](t3-thread://v1/<threadId>)\` using the exact, unencoded \`threadId\`.`,
  `### Choose the workspace before starting a new thread

For an authorized top-level thread, \`t3_thread_launch\` binds and prepares its workspace before the agent starts. Put the task in \`message\`. Choose \`workspaceStrategy\` explicitly for independent work or a PR stack:

- New worktree: \`{"type":"worktree","baseRef":"feature/base","branch":"feature/change","startFromOrigin":false}\`.
- Existing worktree: \`{"type":"existing_worktree","worktreePath":"/absolute/path","branch":"feature/change"}\`. Discover paths with \`t3_worktree_list\`.
- Main checkout: \`{"type":"root"}\`, also the default when omitted. The caller's worktree is not inherited.

For stacks, use the parent branch's local commits with \`baseRef\` and \`startFromOrigin:false\`; true fetches and starts from its remote. Uncommitted edits are excluded. Project, model selection, and modes inherit unless supplied; modes cannot exceed yours.

Use \`t3_thread_launch\` for one thread; \`create_threads\` batches threads sharing the caller's project, branch, and checkout, with no workspace override. Shell \`git worktree add\` / \`cd\` does not update thread bindings. \`t3_worktree_handoff\` moves only the caller, and only if it is not already in a worktree.

Keep the returned \`threadId\`; preparation may still be running. Read with \`t3_thread_read\` / \`t3_thread_wait\`. Launch has no idempotency key, so inspect \`t3_thread_list\` before retrying a failed or lost response.`,
  `MCP prefixes such as \`mcp__t3_code__\` preserve tool semantics. Tools may load lazily: after an empty catalog scan, try \`tools.mcp__t3_code__orchestrator_capabilities({})\` once before declaring T3 delegation unavailable. Bound waits, reuse active work, and keep \`clientRequestId\` stable on retries.

If tools are absent and \`T3_ACP_MCP_NODE\` exists, use the supported terminal transport: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\`. \`T3_ACP_MCP_ENTRYPOINT\` is unset for standalone executables. Substitute the tool name and JSON arguments, for example \`delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.

### Showing visuals

When a visual explains more than prose, build self-contained HTML, check with \`html_preview\`, and publish with \`html_render\` before replying. The page appears above the reply; do not restate it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Keep the wrapper explicit so it cannot be mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
