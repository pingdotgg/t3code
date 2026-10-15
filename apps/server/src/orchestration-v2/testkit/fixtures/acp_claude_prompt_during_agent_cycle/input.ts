import type { OrchestratorFixtureInput } from "../shared.ts";

export const ACP_CLAUDE_CYCLE_FIRST_PROMPT = "Start a background subagent that waits.";
export const ACP_CLAUDE_CYCLE_SECOND_PROMPT = "What else is left to do?";

// Claude Agent on ACP v2. The second prompt reaches Claude while its own
// follow-up cycle runs, so that cycle's idle arrives before Claude takes the
// prompt in and must not end run 2. A later cycle of Claude's own opens a
// continuation, which the user stops.
export function acpClaudePromptDuringAgentCycleInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_CYCLE_FIRST_PROMPT },
      { type: "message", text: ACP_CLAUDE_CYCLE_SECOND_PROMPT },
      { type: "release_replay_gate", label: "cycle.2.running" },
      { type: "interrupt", targetRunIndex: 3 },
    ],
  };
}
