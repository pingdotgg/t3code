import {
  CommandId,
  type ModelEvaluationRunOutcome,
  type RunId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";

export function modelEvaluationEffects(input: {
  readonly settings: ServerSettings;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOutcome: ModelEvaluationRunOutcome;
  readonly subagentRevision?: number;
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  if (!input.settings.enableModelEvaluations) return [];
  const id =
    input.subagentRevision === undefined
      ? `effect:model-evaluation.generate:${input.runId}`
      : `effect:model-evaluation.generate:${input.runId}:subagents:${input.subagentRevision}`;
  return [
    {
      id,
      commandId: CommandId.make(`command:${id}`),
      threadId: input.threadId,
      request: {
        type: "model-evaluation.generate",
        runId: input.runId,
        runOutcome: input.runOutcome,
      },
    },
  ];
}
