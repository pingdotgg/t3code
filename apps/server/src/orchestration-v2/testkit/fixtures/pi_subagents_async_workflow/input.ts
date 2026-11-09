import type { OrchestratorFixtureInput } from "../shared.ts";

const PI_SUBAGENTS_ASYNC_WORKFLOW_PROMPT =
  'Reproduction for a T3 bug report. Do exactly this and nothing else: write this one workflow block in your reply, then call subagent({ workflow: true, async: true }). Do not modify any files.\n\n```js workflow\nconst alpha = await runs.all([{ key: "alpha", agent: "scout", task: "Run `sleep 60` with bash, then reply with exactly: ALPHA-DONE" }]);\nconst beta = await runs.all([{ key: "beta", agent: "scout", task: "Run `sleep 90` with bash, then reply with exactly: BETA-DONE" }]);\nreturn [...alpha, ...beta].map((r) => r.output);\n```\n\nAfter launching, end your turn and wait for the completion notice.';

/** Run 2 is the native wake pi-subagents starts for its completion notice. */
export function piSubagentsAsyncWorkflowInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: PI_SUBAGENTS_ASYNC_WORKFLOW_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
