import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_COMPACT_FIRST_PROMPT = "Reply with exactly: compact probe first turn";
// Held until the continuation run settles, as the CLI process outlives it.
const CLAUDE_COMPACT_LAST_FRAME_LABEL = "command_lifecycle:compact-completed";

// A `/compact` that Claude answers only after a turn of its own: a peer
// message woke it while the compaction was queued (the frames of a live
// `claude` 2.1.285 `/compact` with a peer-origin turn from a provider log
// spliced in front of it).
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
