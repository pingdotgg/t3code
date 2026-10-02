import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT = [
  "Live-test interrupting a turn that owns background work. You must make two Bash tool calls, one after the other. Do exactly this, with no extra steps.",
  "",
  "1) Call the Bash tool with run_in_background set to true and this exact command:",
  "   sleep 30 && echo BG_INTERRUPT_DONE",
  "2) After that call returns, call the Bash tool again in the foreground (run_in_background false) with this exact command and wait for it:",
  `   node -e "setTimeout(() => console.log('FG_DONE'), 30000)"`,
  "3) After it finishes, reply with exactly FINISHED.",
].join("\n");

export function claudeBackgroundTaskInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT },
      // The recording interrupted right after the foreground tool use.
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
