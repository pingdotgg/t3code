import {
  CommandId,
  type AssistedLearningRunOutcome,
  type ProjectId,
  type RunId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PendingOrchestrationEffectV2 } from "../../orchestration-v2/EffectOutbox.ts";

export function assistedLearningEffects(input: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
}): ReadonlyArray<PendingOrchestrationEffectV2> {
  if (!resolveProjectSettings(input.settings, input.projectId).settings.enableAssistedLearning)
    return [];
  const runOutcome: AssistedLearningRunOutcome =
    input.status === "cancelled" ? "interrupted" : input.status;
  return [
    {
      id: `effect:project-knowledge.extract:${input.runId}`,
      commandId: CommandId.make(`command:effect:project-knowledge.extract:${input.runId}`),
      threadId: input.threadId,
      request: { type: "project-knowledge.extract", runId: input.runId, runOutcome },
    },
  ];
}

/**
 * A reference with a no-op default so orchestration layers built without project knowledge
 * (tests, the CLI) still run; the server provides the real job.
 */
/** Storage or projection failures; the effect worker retries the job on these. */
export class AssistedLearningError extends Schema.TaggedError<AssistedLearningError>()(
  "AssistedLearningError",
  { runId: Schema.String, cause: Schema.Defect() },
) {}

export interface AssistedLearningRunnerShape {
  readonly extractRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly runOutcome: AssistedLearningRunOutcome;
  }) => Effect.Effect<void, AssistedLearningError>;
}

export class AssistedLearningRunner extends Context.Reference<AssistedLearningRunnerShape>(
  "t3/project/knowledge/AssistedLearningRunner",
  {
    defaultValue: () => ({ extractRun: () => Effect.void }),
  },
) {}
