import { OPENCODE2_NESTED_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2NestedBackgroundInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_NESTED_BACKGROUND_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
    ],
  };
}
