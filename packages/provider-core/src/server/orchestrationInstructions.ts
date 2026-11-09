import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Agents come first. The user's T3 Agents (\`agents\` in \`orchestrator_capabilities\`, or \`t3_list_agents\`) are named specialists with their own instructions, skills, model, and modes. When work matches an agent, or the user names one, run it as that agent: pass its \`profileId\` to \`delegate_task\`, \`t3_thread_launch\`, or \`create_threads\`, and omit \`target\`/\`modelSelection\` and modes so the agent's own settings apply. Set them only to deliberately override the agent. Use a bare provider/model target or a plain thread only when no agent fits. Native subagents cannot run as a T3 agent. An agent whose modes are broader than this thread's runs at this thread's modes. If a call with \`profileId\` fails, do not retry without it or fall back to a bare model: report the returned error to the user and let them decide.
- Children and subagents are different. A child is a full agent chat with its own context that you launch to do a separate part of a larger task; it shows inside your card on the Agents board, keeps its own status, and settles on its own. A subagent is a helper inside your own run that saves your context; it shows only in your thread's Lineage panel. Leading other agents does not make your children subagents.
- Launch a child for separate work: \`t3_thread_launch\` (one chat, with its own \`workspaceStrategy\`) or \`create_threads\` (several chats sharing this checkout), passing the agent's \`profileId\`. A \`delegate_task\` run as a named agent (\`profileId\`) is also a child. Wait for its thread with \`t3_thread_wait\` and read it with \`t3_thread_read\`; \`task_status\` also exposes its result. A child's question is the only automatic message it sends back: answer it, or ask your own parent or the user.`,
  `- Use a subagent to save your own context: native subagent tools, or \`delegate_task\` without a \`profileId\` for a short helper. Pass \`isolation:"worktree"\` to \`delegate_task\` when a child task needs a separate checkout. Discover agents and current provider/model IDs with \`orchestrator_capabilities\` (pass \`search\` for models it leaves out); a native tool's model list is not the full list of available models. Prefer native subagent tools for same-provider helpers only when they support the chosen model and no model options are requested or inherited; otherwise use \`delegate_task\` with that provider instance and model, including for same-provider or cross-provider work. Background agent: \`delegate_task\`, never a background \`Agent\`. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it.
- For independent T3 delegated review rounds, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. For a follow-up that needs the same child's conversation, use \`t3_thread_send\` on its \`childThreadId\`.`,
  `- \`schedule_task\` creates persistent timed or webhook-triggered work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text. By default runs return to the current thread, which suits orchestrating: each trigger arrives here and you delegate or dedupe; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time, or the webhook's \`webhookUrl\`.
- When you need a secret only the user can give (a login, token, API key, PIN, pairing code, webhook signing secret, or sudo password), call \`request_secret\` so they enter it privately, not a chat ask or a handoff, then pass the returned \`secretRef\` to the tool that needs it. Not for access you have. Sudo: if \`sudo -n <cmd>\` says a password is required, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. A \`secretRef\` works once. Never ask for a secret in chat, never invent one, and never repeat one.
- To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.`,
  `### Choose the workspace before starting a new thread

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\` (\`worktree\`, \`existing_worktree\`, or \`root\`). Omitting workspaceStrategy selects the project root; it does not inherit the caller's worktree. Honor a requested base. Otherwise, independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. For stacked work or required unpublished commits, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths.

Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.`,
  `Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\` (pass the HTML file's path or inline HTML), then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`,
  `- When model options are requested or the child keeps the parent's provider instance and model with nonempty \`inheritedOptions\` from \`orchestrator_capabilities\`, use \`delegate_task\` even for native-supported models. Native subagents cannot reliably apply T3 model options. Read the selected model's descriptors from \`orchestrator_capabilities\` and put settings in \`target.options\`, not only in the prompt. Do not translate max to high or ignore unsupported settings: report a capability mismatch. Check the returned providerInstanceId, model, and options against the requested selection.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
