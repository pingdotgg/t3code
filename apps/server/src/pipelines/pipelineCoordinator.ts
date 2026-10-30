import type { PipelineRunId } from "@t3tools/contracts";

/**
 * Sent to the provider with the first turn of a pipeline parent thread's provider thread, never
 * stored as a message, so it stays out of the user's timeline.
 */
function pipelineCoordinatorInstructions(runId: PipelineRunId): string {
  return `You are the coordinator of pipeline run \`${runId}\`. This chat is how the user steers the whole run. Each step of the run has its own thread, with its own agent.
- Coordinate; do not edit files. Steps share one workspace, so an edit from here can collide with a running step.
- Read live state with \`pipeline_status\` (and \`t3_thread_read\` for a step's thread) at the start of each turn. Name a step's thread by its \`link\`, verbatim.
- When the user gives feedback on an earlier step's work, call \`revise_pipeline_step\` for the step it is about. That step fixes it in its own thread, then every later step redoes its work. A message that quotes a step ("From step <name> (<link>)") is about that step.
- Use \`rerun_pipeline_step\` only to start over from a step with fresh threads. Use \`continue_pipeline\` to get past a pause only when the user's latest message asks you to. Use \`cancel_pipeline\` only when asked.
- Reply briefly: say what you did and which steps will redo their work.`;
}

/**
 * The instructions a coordinator turn carries, or "" when none belong on it: other threads,
 * native commands, and any turn after the provider thread already ran one for an earlier message.
 */
export function pipelineCoordinatorNote(input: {
  readonly pipeline: { readonly runId: PipelineRunId; readonly stepId: string | null } | undefined;
  readonly nativeCommand: boolean;
  readonly providerThreadId: string;
  readonly activeAttemptId: string | null;
  readonly providerTurns: ReadonlyArray<{
    readonly providerThreadId: string;
    readonly runAttemptId: string | null;
    readonly status: string;
  }>;
}): string {
  const { pipeline } = input;
  if (input.nativeCommand || pipeline === undefined || pipeline.stepId !== null) return "";
  const alreadySent = input.providerTurns.some(
    (turn) =>
      turn.providerThreadId === input.providerThreadId &&
      turn.runAttemptId !== input.activeAttemptId &&
      (turn.status === "completed" || turn.status === "running"),
  );
  return alreadySent ? "" : pipelineCoordinatorInstructions(pipeline.runId);
}
