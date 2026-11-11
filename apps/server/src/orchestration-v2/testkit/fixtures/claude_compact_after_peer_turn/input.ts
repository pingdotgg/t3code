import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_COMPACT_FIRST_PROMPT = "Reply with exactly: compact probe first turn";
// Held until the continuation run settles, as the CLI process outlives it.
const CLAUDE_COMPACT_LAST_FRAME_LABEL = "command_lifecycle:compact-completed";

// Splice a peer-origin turn before live Claude 2.1.285 /compact frames to model queued compaction.
export function claudeCompactAfterPeerTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_COMPACT_FIRST_PROMPT },
      { type: "message", text: "/compact" },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
      { type: "release_replay_gate", label: CLAUDE_COMPACT_LAST_FRAME_LABEL },
    ],
  };
}

export function claudeCompactAfterPeerTurnNoEchoInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_COMPACT_FIRST_PROMPT },
      { type: "message", text: "/compact" },
    ],
  };
}
