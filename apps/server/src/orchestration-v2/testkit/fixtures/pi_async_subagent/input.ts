import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import type { OrchestratorFixtureInput } from "../shared.ts";

/**
 * Record with `T3_PI_RECORD_EXTENSION=<pi-subagents 0.77.0 or later>/index.ts`,
 * and with `PI_CODING_AGENT_DIR` pointing at a directory that holds only
 * credentials.
 */
export const PI_ASYNC_SUBAGENT_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "openai-codex/gpt-6-luna",
} satisfies ModelSelection;

export const PI_ASYNC_SUBAGENT_AGENT = "echo";
export const PI_ASYNC_SUBAGENT_TASK = "Reply with exactly: ECHO_DONE";

export const PI_ASYNC_SUBAGENT_PROMPT = [
  "Live-test an async subagent that finishes after your turn ends. Do exactly this, with no extra steps.",
  "",
  `1) Call the subagent tool once with agent "${PI_ASYNC_SUBAGENT_AGENT}", task "${PI_ASYNC_SUBAGENT_TASK}", and async true.`,
  "2) Immediately after it returns, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

const ECHO_AGENT = [
  "---",
  `name: ${PI_ASYNC_SUBAGENT_AGENT}`,
  "description: Replies with the text its task asks for.",
  `model: ${PI_ASYNC_SUBAGENT_MODEL_SELECTION.model}`,
  "thinking: low",
  "tools: read",
  "---",
  "",
  "Reply with exactly the text the task asks for and nothing else.",
  "",
].join("\n");

export function piAsyncSubagentInput(): OrchestratorFixtureInput {
  return {
    workspaceFiles: { [`.pi/agents/${PI_ASYNC_SUBAGENT_AGENT}.md`]: ECHO_AGENT },
    steps: [
      { type: "message", text: PI_ASYNC_SUBAGENT_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
