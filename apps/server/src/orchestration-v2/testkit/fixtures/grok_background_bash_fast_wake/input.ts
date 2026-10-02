import type { OrchestratorFixtureInput } from "../shared.ts";
import { GROK_BACKGROUND_BASH_PROMPT } from "../grok_background_bash/input.ts";

// Same prompt as grok_background_bash, recorded from Grok 1.0.44. Older Grok
// (1.0.41) waited about a minute after `x.ai/task_completed` before starting
// its `task-completed-*` reply; 1.0.44 starts it within ~2s, inside the finish
// debounce while run 1 is still held for the command. Frames replay ungated so
// that timing is preserved: the reply must settle run 1 and open a continuation
// run instead of streaming into the held root run.
export function grokBackgroundBashFastWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
