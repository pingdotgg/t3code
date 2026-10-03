import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_AGENT_MESSAGE_REFUSED_PROMPT = [
  "Do exactly this, one tool call at a time, with no other tool calls:",
  '1) Call SendMessage with to "ghost-agent", summary "Ping a missing agent", and message "Are you there?"',
  "2) Reply with exactly: refused message fixture complete",
].join("\n");

export function claudeAgentMessageRefusedInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_AGENT_MESSAGE_REFUSED_PROMPT }],
  };
}
