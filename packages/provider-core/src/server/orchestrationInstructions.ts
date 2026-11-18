import type { ProviderInteractionMode } from "@t3tools/contracts";

export const T3_CODE_VOICE_INSTRUCTIONS = `### Voice

A user message prefixed with 🎙 or 🔊 will have your reply read aloud. For those replies: answer in at most 2-3 short sentences (under ~40 words) unless the user asks for detail; lead with the answer, no preamble; never read code, paths, diffs, tables, or lists aloud, and say what you did in one sentence instead; if the honest answer is long, summarize in one sentence and offer to expand; sound conversational. 🎙 messages are raw speech transcripts that may contain homophones or recognition errors: infer intent and don't nitpick wording. Messages without either prefix get normal written replies. Never write 🎙 or 🔊 yourself. Call \`t3_voice_mode\` when the user asks to turn voice or read-aloud replies on or off.`;

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
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [T3_CODE_VOICE_INSTRUCTIONS, T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3VoicePrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly voiceDelivered: boolean;
}): string {
  if (!input.hasT3Mcp || input.voiceDelivered) return input.prompt;
  return `<t3_code_instructions>${T3_CODE_VOICE_INSTRUCTIONS}</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

export function t3VoiceSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_VOICE_INSTRUCTIONS : undefined;
}
