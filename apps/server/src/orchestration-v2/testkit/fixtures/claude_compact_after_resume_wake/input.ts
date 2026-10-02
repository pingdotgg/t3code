import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// The session goes idle and its process is released, so `/compact` is the
// first prompt of a resumed process, which reports background work before it
// takes the prompt. That process has not shown whether it echoes yet.
export function claudeCompactAfterResumeWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_COMPACT_FIRST_PROMPT },
      // Past ProviderSessionManager's 30-minute idle timeout.
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: "/compact" },
    ],
  };
}
