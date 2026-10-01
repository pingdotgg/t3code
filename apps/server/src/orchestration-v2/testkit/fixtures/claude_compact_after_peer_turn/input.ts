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
      // The peer turn's reply, which the continuation worker queues behind
      // `/compact`, runs on the same live process.
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
      { type: "release_replay_gate", label: CLAUDE_COMPACT_LAST_FRAME_LABEL },
    ],
  };
}

// The same scenario on a CLI that never echoes: nothing marks the peer
// turn as another turn's, so no continuation follows.
export function claudeCompactAfterPeerTurnNoEchoInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_COMPACT_FIRST_PROMPT },
      { type: "message", text: "/compact" },
    ],
  };
}
