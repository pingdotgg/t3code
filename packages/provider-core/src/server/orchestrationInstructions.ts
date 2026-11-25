// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). When a configured local profile fits, delegate with \`acp-mcp-call delegate_task '{"task":"...","profile":"...","mode":"async","clientRequestId":"..."}'\`. To override its model, set only \`target.model\` with a vendor-qualified catalog model. Without a profile, choose a provider and model from the catalog in \`target\`. On Windows, run \`T3_ACP_MCP_CALL\` instead and pipe the JSON to stdin, as in PowerShell \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`, writing non-ASCII characters as \`\\uXXXX\` escapes.`;

export interface T3AcpInstructionState {
  readonly hasT3Mcp: boolean;
}

/** ACP lacks system/developer fields; inject the MCP fallback on the first prompt and when the T3 tools appear. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (!input.state.hasT3Mcp || input.previousState?.hasT3Mcp === true) return input.prompt;
  return `<t3_code_instructions>\n${T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}
