import type { OrchestratorFixtureInput } from "../shared.ts";
import { CLAUDE_AUTO_MODE_PROMPT } from "../claude_auto_mode/input.ts";

/** Project settings that turn Claude's auto mode off; seed them when recording and replaying. */
export const CLAUDE_AUTO_MODE_UNAVAILABLE_WORKSPACE_FILES = {
  ".claude/settings.json": `${JSON.stringify({ disableAutoMode: "disable" }, null, 2)}\n`,
} as const;

export function claudeAutoModeUnavailableInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    workspaceFiles: CLAUDE_AUTO_MODE_UNAVAILABLE_WORKSPACE_FILES,
    steps: [
      { type: "message", text: CLAUDE_AUTO_MODE_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
    ],
  };
}
