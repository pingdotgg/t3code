import { ThreadTokenUsageSnapshot, type WorkflowStepUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { StepUsageReader, type StepUsageReaderShape } from "../Services/StepUsageReader.ts";

const decodeUsageSnapshot = Schema.decodeUnknownEffect(ThreadTokenUsageSnapshot);

const toWorkflowUsage = (snapshot: ThreadTokenUsageSnapshot): WorkflowStepUsage | undefined => {
  const usage = {
    ...(snapshot.inputTokens === undefined ? {} : { inputTokens: snapshot.inputTokens }),
    ...(snapshot.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: snapshot.cachedInputTokens }),
    ...(snapshot.outputTokens === undefined ? {} : { outputTokens: snapshot.outputTokens }),
    totalTokens: snapshot.totalProcessedTokens ?? snapshot.usedTokens,
  } satisfies WorkflowStepUsage;
  return usage.totalTokens === 0 && usage.inputTokens === undefined ? undefined : usage;
};

const make = Effect.gen(function* () {
  const activities = yield* ProjectionThreadActivityRepository;

  const read: StepUsageReaderShape["read"] = (threadId) =>
    Effect.gen(function* () {
      const rows = yield* activities.listByThreadId({ threadId });
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.kind !== "context-window.updated") {
          continue;
        }
        const snapshot = yield* decodeUsageSnapshot(row.payload).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (snapshot !== null) {
          return toWorkflowUsage(snapshot);
        }
      }
      return undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));

  return { read } satisfies StepUsageReaderShape;
});

export const StepUsageReaderLive = Layer.effect(StepUsageReader, make);
