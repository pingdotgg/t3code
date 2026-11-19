import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary tasks need no T3 tools.

For unfinished, context-heavy top-level work, probe \`t3_thread_transfer\` (\`action:"continue"\`, no \`handoff\`). Honor stay requests; skip child/near-finished work. If enabled, finish active work, call last with \`handoff\` (goal, decisions, workspace/branch, uncommitted work, checks/failures/next steps). Remain here unless handoff returns \`targetThreadId\`; then end. Receiving thread: work substantially before rollover.

- Use native tools for same-provider children on offered models with no extra settings (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for other-provider models (even with native types), requested settings, separate checkouts (\`isolation:"worktree"\`), explicit requests for that tool, or background agents. Never background \`Agent\`. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread before first \`delegate_task\`, repeating only after errors or user-named provider changes. Settings go in \`target.options\`. Report unavailable providers/models. Never switch unasked, fall back to native tools/Workflow/CLIs, or create child checkouts in shell or \`task\`.
- Use a new \`delegate_task\` for every delegate review/re-check (brief, findings, objections), never \`t3_thread_send\`. Fix small findings yourself. If told to use fewer or no delegates, \`task_cancel\` extras without replacement.
- Follow delegate \`next\`; never poll via \`task_status\`, \`sleep\`, watchers, Monitor or ScheduleWakeup. Cancel replaced/unneeded runs via \`task_cancel\`, never \`t3_thread_interrupt\` on \`childThreadId\`.
- Children and subagents do their own work. Delegate only if tasked.`,
  `- \`t3_thread_launch\`/\`create_threads\` make top-level threads only on user request; subagent/delegate/parallel aren't requests. Worktrees: set \`workspaceStrategy\` and honor requested bases. Independent work starts from default \`remote/branch\` with \`startFromOrigin:true\` (local default without remote); use local bases for unpublished commits/dependent work. Shell worktrees don't bind a base; no shell checkout setup in task prompts. Without \`workspaceStrategy\`, use project root, not worktree.
- Given a thread id, call \`t3_thread_read\` before answering; when asked to settle a thread, organize this one too with \`t3_thread_organize\`.
- Another machine: use \`t3_environment_links\`; pass that machine's \`environmentId\` and \`threadId\` to T3 tools.
- Unlinked "delegate this to my vps": call \`t3_environment_link\` with a hint from the user's words; never share a pairing code in chat. If unavailable, direct them to Settings → Labs → Linked environments.
- Replies must name threads by their verbatim \`link\`, never title or bare id.
- Use \`request_secret\` for logins, tokens, PINs, pairing codes or sudo passwords only the user can give; never ask or hand off in chat, and not for access you have. If \`sudo -n <cmd>\` needs a password, use \`delivery:"file"\` and \`sudo -S -p '' <cmd> < "$file"\`; password uses stdin, so pass other input by file. For scheduling only, call \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Chart trends and comparisons. Show requested visuals here via \`html_preview\` (HTML file path or inline HTML), then \`html_render\`. A screenshot on disk or a description doesn't show it. Never start a server for this. Use page tools for writes only on request, never to show results. Images for use elsewhere need a \`.png\` file and path; never \`html_render\`.
- Use \`preview_*\` only when the current request asks for browser work (including recording edits) or names a page/tab. Never use them unasked to verify or show your edit, or repeat prior-turn calls. For public pages, fetch/search unless browser work was asked; then use preview tools only. Close tabs you opened before replying unless the user asked to keep them or uses them.`,
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
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. On Windows, run \`T3_ACP_MCP_CALL\` instead and pipe the JSON to stdin, as in PowerShell \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`, writing non-ASCII characters as \`\\uXXXX\` escapes.`;

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
  /** Guidance for this provider's own tools, sent until `providerInstructionsDelivered`. */
  readonly providerInstructions?: string;
  readonly providerInstructionsDelivered?: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  const instructions = [
    !input.orchestrationDelivered
      ? orchestrationInstructions(input.hasDeviceTools)
      : input.hasDeviceTools && !input.deviceInstructionsDelivered
        ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS
        : undefined,
    input.providerInstructionsDelivered === true ? undefined : input.providerInstructions,
  ].flatMap((part) => (part === undefined ? [] : [part.trim()]));
  return instructions.length === 0
    ? input.prompt
    : prependT3OrchestrationInstructions(input.prompt, instructions.join("\n\n"));
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
