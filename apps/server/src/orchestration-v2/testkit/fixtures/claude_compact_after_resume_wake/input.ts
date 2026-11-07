import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export function claudeCompactAfterResumeWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_COMPACT_FIRST_PROMPT },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: "/compact" },
    ],
  };
}
