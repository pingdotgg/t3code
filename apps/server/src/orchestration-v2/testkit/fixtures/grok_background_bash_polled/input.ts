import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_BACKGROUND_BASH_POLLED_PROMPT =
  "Run the build, lint and test commands, wait for all three, then reply exactly POLLED_DONE.";

// Grok 1.0.46 moves each command to the background with a `call-<uuid>-<n>`
// task id, ends it with `task_completed` before the poll result (one without
// its output), and reports the first through a TaskOutput `Result` and the
// other two through one `MultiResult`. Every command ends inside the turn, so
// nothing holds run 1.
export function grokBackgroundBashPolledInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: GROK_BACKGROUND_BASH_POLLED_PROMPT }],
  };
}
