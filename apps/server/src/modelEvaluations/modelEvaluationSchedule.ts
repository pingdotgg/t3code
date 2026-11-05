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
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  if (!input.settings.enableModelEvaluations) return [];
  return [
    {
      id: `effect:model-evaluation.generate:${input.runId}`,
      commandId: CommandId.make(`command:effect:model-evaluation.generate:${input.runId}`),
      threadId: input.threadId,
      request: {
        type: "model-evaluation.generate",
        runId: input.runId,
        runOutcome: input.runOutcome,
      },
    },
  ];
}
