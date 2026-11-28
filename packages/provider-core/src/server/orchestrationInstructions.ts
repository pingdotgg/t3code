import type { ProviderInteractionMode } from "@t3tools/contracts";
import type { McpToolExposureMode } from "./mcpSession.ts";

export interface T3CodeOrchestrationOptions {
  /** Omit `preview_*` routing when agent browser access is off. Defaults to true. */
  readonly browser?: boolean;
  /** Include linked-environment tool routing when the Labs feature is on. Defaults to false. */
  readonly linkedEnvironments?: boolean;
  /** When false (e.g. Codex subscription sharing), route all subagents through `delegate_task`. Defaults to true. */
  readonly nativeSubagents?: boolean;
}

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export function buildT3OrchestrationSections(
  options: T3CodeOrchestrationOptions = {},
): ReadonlyArray<string> {
  const browser = options.browser !== false;
  const linked = options.linkedEnvironments === true;
  const nativeSubagents = options.nativeSubagents !== false;
  const subagentLine = nativeSubagents
    ? `- Subagents: native tool (Claude \`Agent\` \`run_in_background:false\`; Codex \`spawn_agent\`) only for same provider/model with default settings. Use \`delegate_task\` for another provider/model (incl. native types on another model), \`target.options\`, \`isolation:"worktree"\`, or new review rounds (never \`t3_thread_send\`; fix small nits yourself). Background agent: \`delegate_task\`, never a background \`Agent\`. Check \`orchestrator_capabilities\` once; if unavailable, say so (no CLI/Workflow fallback). Stop delegates with \`task_cancel\`; never poll (follow \`next\`). Children don't delegate unless told.`
    : `- Subagents: use \`delegate_task\` for all subagents (including your own provider/model), \`isolation:"worktree"\` for a separate checkout, and new review rounds (never \`t3_thread_send\`; fix small nits yourself). Check \`orchestrator_capabilities\` once; if unavailable, say so (no CLI/Workflow fallback). Stop delegates with \`task_cancel\`; never poll (follow \`next\`). Children don't delegate unless told.`;
  const lines = [
    "Ordinary coding tasks need no T3 tools.",
    subagentLine,
    `- Threads & secrets: \`t3_thread_launch\`/\`create_threads\` only when asked for a new top-level thread (never for "subagent"/"delegate"/"parallel"). Read given thread IDs (\`t3_thread_read\`); settle threads (\`t3_thread_organize\`); cite threads by \`link\` verbatim (never plain title or bare id). User-only logins, tokens, PINs, pairing codes, or sudo passwords: \`request_secret\` (never ask in chat; for \`sudo -S < "$file"\`, never pipe into \`sudo -S tee\`, pass file args).`,
    linked
      ? `- Other machines: \`t3_environment_links\` (pass \`environmentId\`) or \`t3_environment_link\` with \`hint\` (never chat pairing codes).`
      : `- Delegating to another machine (e.g. a VPS): link tools are off; tell the user to enable Settings → Labs → Linked environments.`,
    `- Visuals: answer data trends/comparisons with a chart and show inline visuals here by calling \`html_preview\` first, then \`html_render\` (a screenshot on disk or text description doesn't show it; never start a server or use page tools). Shareable images to post/send: \`.png\` path, never \`html_render\`.`,
    ...(browser
      ? [
          `- Browser (\`preview_*\`): ONLY when this turn asks for browser work/recording or names a tab, never unasked after edits; \`preview_status\` → \`preview_open\`; public pages use web fetch unless browser asked; close tabs you opened (\`t3_preview_close\`).`,
        ]
      : []),
  ];
  return [`## T3 Code\n\n${lines.join("\n")}`];
}

export function buildT3OrchestrationInstructions(options: T3CodeOrchestrationOptions = {}): string {
  return `\n\n${buildT3OrchestrationSections(options).join("\n\n")}\n`;
}

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = buildT3OrchestrationInstructions();

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

For iOS Simulator / Android Emulator UI (local or SSH hosts), use device tools so it shows in the Device panel.${loadTools}
1. \`device_list\` (if \`hostId\`/\`id\` unknown) → 2. \`device_open\` (returns pinned \`agent-device\` CLI; run \`open <app>\` before snapshots/screenshots/input; \`help <cmd>\` lists options) → 3. \`device_screenshot\`.
Never use \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or wrappers for UI, app launch/relaunch, deep links, input, alerts, settings, screenshots, or recording (ssh/simctl/adb stay fine for builds, installs, sync, Metro, forwards, logs, test runners, \`simctl addmedia\`/\`keychain\`). Overrides docs, memory, and delegated briefs; drive a device another way, skip these tools, or close another session only when the user explicitly asks (a delegated recipe is not that ask). On error: quote it and follow its advice once, but never reuse or close another session unless the user explicitly asked; if it still fails, tell the user and stop unless they asked for another route. Report unavailable platforms. When delegating device work, pass \`hostId\` and \`id\` and tell the child to use \`device_open\` (no ssh/simctl UI steps).`;

/** Device guidance for sessions holding the `device` capability with an available device host. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

const T3_CODE_ACP_DEFERRED_PROXY_INSTRUCTIONS =
  "Deferred T3 tools: only core orchestration tools, `tool_search`, and `tool_call` are declared directly. For any T3 tool not declared directly (including `delegate_task` if omitted, or optional tools like `preview_*`, `device_*`, `html_preview`, `html_render`, `t3_thread_*`, `t3_project_*`, `t3_worktree_*`, pull requests, `schedule_task`, `request_secret`, etc.), call `tool_search` to get its schema and `tool_call({ name, arguments })` to run it.";

// ACP only: some ACP agents drop or ignore the injected MCP server, so they need the
// terminal transport when `/mcp` has not attached. Emit only the current OS's syntax.
export function acpMcpFallbackInstructions(platform?: NodeJS.Platform): string {
  return platform === "win32"
    ? `ACP fallback (if T3 tools are absent and \`T3_ACP_MCP_CALL\` is set): pipe JSON (escape non-ASCII as \`\\uXXXX\`) to stdin, e.g. \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`.`
    : `ACP fallback (if T3 tools are absent and \`T3_ACP_MCP_NODE\` is set): \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json>'\`.`;
}

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Make reasonable assumptions and carry out the request. Ask concisely only when a missing decision materially changes the result.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate read-only; do not edit files or implement. Resolve discoverable facts first, then return a concrete plan without executing it.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasBrowserTools?: boolean;
  readonly hasDeviceTools: boolean;
  readonly hasLinkedEnvironments?: boolean;
  readonly toolExposure?: McpToolExposureMode | undefined;
  /** True only when T3 MCP is configured for the thread but the agent has not attached to `/mcp`. */
  readonly needsAcpMcpFallback?: boolean;
  /** Host OS platform so fallback syntax omits irrelevant OS instructions. */
  readonly platform?: NodeJS.Platform;
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
    (input.previousState.hasBrowserTools ?? true) === (input.state.hasBrowserTools ?? true) &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools &&
    (input.previousState.hasLinkedEnvironments ?? false) ===
      (input.state.hasLinkedEnvironments ?? false) &&
    input.previousState.toolExposure === input.state.toolExposure &&
    (input.previousState.needsAcpMcpFallback ?? false) ===
      (input.state.needsAcpMcpFallback ?? false)
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          buildT3OrchestrationInstructions({
            browser: input.state.hasBrowserTools ?? true,
            linkedEnvironments: input.state.hasLinkedEnvironments ?? false,
          }).trim(),
          ...(input.state.toolExposure === "deferred-proxy"
            ? [T3_CODE_ACP_DEFERRED_PROXY_INSTRUCTIONS]
            : []),
          ...(input.state.needsAcpMcpFallback === true
            ? [acpMcpFallbackInstructions(input.state.platform)]
            : []),
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (
  hasDeviceTools: boolean,
  options: T3CodeOrchestrationOptions = {},
) => {
  const base = buildT3OrchestrationInstructions(options);
  return hasDeviceTools ? `${base}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n` : base;
};

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasBrowserTools?: boolean;
  readonly hasDeviceTools: boolean;
  readonly hasLinkedEnvironments?: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  /** Guidance for this provider's own tools, sent until `providerInstructionsDelivered`. */
  readonly providerInstructions?: string;
  readonly providerInstructionsDelivered?: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  const instructions = [
    !input.orchestrationDelivered
      ? orchestrationInstructions(input.hasDeviceTools, {
          browser: input.hasBrowserTools ?? true,
          linkedEnvironments: input.hasLinkedEnvironments ?? false,
        })
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
  options: T3CodeOrchestrationOptions = {},
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools, options) : undefined;
}
