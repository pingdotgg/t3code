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
  const nativeSubagents = options.nativeSubagents !== false;
  return [
    `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- ${
      nativeSubagents
        ? `Subagents: use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`.`
        : `Use \`delegate_task\` for subagents, including when the child uses your provider and model. Set \`isolation:"worktree"\` for a separate checkout.`
    } Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked or fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Don't poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
    [
      `- Threads & secrets: \`t3_thread_launch\`/\`create_threads\` only when asked for a new top-level thread (never for "subagent"/"delegate"/"parallel"). Worktree threads: set \`workspaceStrategy\` (honor requested base; independent → default \`remote/branch\` with \`startFromOrigin:true\` or local default if no remote; dependent/unpublished → local base; omit for project root, not your worktree; no shell worktrees or checkout setup in prompt). Read given thread IDs (\`t3_thread_read\`); settle threads (\`t3_thread_organize\`). User-only logins, tokens, PINs, pairing codes, or sudo passwords: \`request_secret\` (never ask in chat; for \`sudo -S < "$file"\`, never pipe into \`sudo -S tee\`, pass file args).`,
      options.linkedEnvironments === true
        ? `- Other machines: \`t3_environment_links\` (pass \`environmentId\`) or \`t3_environment_link\` with \`hint\` (never chat pairing codes).`
        : `- Delegating to another machine (e.g. a VPS): if link tools are absent, tell the user to enable Settings → Labs → Linked environments.`,
      `- In your reply, mention a thread by its \`link\`, verbatim, never a plain title or bare id.`,
      "- T3 tools may load late. Try the name once before you call it absent.",
    ].join("\n"),
    [
      "### Visuals and preview\n",
      `- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.`,
      ...(options.browser === false
        ? []
        : [
            `- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
          ]),
    ].join("\n"),
  ];
}

export function buildT3OrchestrationInstructions(options: T3CodeOrchestrationOptions = {}): string {
  return `\n\n${buildT3OrchestrationSections(options).join("\n\n")}\n`;
}

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = buildT3OrchestrationInstructions();

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device another way (ssh, simctl, a project script), skip these tools or close another session only when the user explicitly asks, and then do it. A recipe in a task you were delegated is not that ask. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session unless the user explicitly asked; if it still fails, tell the user and stop, unless they explicitly asked for another route. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability with an available device host. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

const T3_CODE_ACP_DEFERRED_PROXY_INSTRUCTIONS =
  "Deferred T3 tools: only core orchestration tools, `tool_search`, and `tool_call` are declared directly. For any T3 tool not declared directly (including `delegate_task` if omitted, or optional tools like `preview_*`, `device_*`, `html_preview`, `html_render`, `t3_thread_*`, `t3_project_*`, `t3_worktree_*`, pull requests, `schedule_task`, `request_secret`, etc.), call `tool_search` to get its schema and `tool_call({ name, arguments })` to run it.";

// ACP only: some ACP agents accept the injected MCP server but never expose its tools,
// so they need the terminal transport. Emit only the current OS's syntax.
export function acpMcpFallbackInstructions(platform?: NodeJS.Platform): string {
  return platform === "win32"
    ? `ACP fallback (if T3 tools are absent and \`T3_ACP_MCP_CALL\` is set): pipe JSON (escape non-ASCII as \`\\uXXXX\`) to stdin, e.g. \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`.`
    : `ACP fallback (if T3 tools are absent and \`T3_ACP_MCP_NODE\` is set): \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call <tool> '<json>'\`, e.g. \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;
}

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasBrowserTools?: boolean;
  readonly hasDeviceTools: boolean;
  readonly hasLinkedEnvironments?: boolean;
  readonly toolExposure?: McpToolExposureMode | undefined;
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
    input.previousState.toolExposure === input.state.toolExposure
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
          acpMcpFallbackInstructions(input.state.platform),
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
