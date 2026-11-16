import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ModelEvaluations from "./ModelEvaluations.ts";

export class ModelEvaluationSubagentRefresh extends Context.Service<
  ModelEvaluationSubagentRefresh,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/modelEvaluations/ModelEvaluationSubagentRefresh") {}

const subscriptionBackoff = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(1))),
  ),
);

function settledSubagentRun(
  event: OrchestrationV2DomainEvent,
): { readonly threadId: ThreadId; readonly runId: RunId } | undefined {
  if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") return undefined;
  if (isOrchestrationV2WorkActive(event.payload.status)) return undefined;
  const runId = event.runId ?? event.payload.runId;
  if (runId === undefined || runId === null) return undefined;
  return { threadId: event.threadId, runId };
}

export const followSettledSubagentRefreshes = Effect.fn("ModelEvaluationSubagentRefresh.follow")(
  function* (input: {
    readonly evaluations: Pick<
      ModelEvaluations.ModelEvaluations["Service"],
      "enqueueSettledSubagentRefreshes"
    >;
    readonly orchestrator: Pick<
      Orchestrator.OrchestratorV2["Service"],
      "getLatestEventSequence" | "streamDomainEventsAfter"
    >;
  }) {
    yield* Effect.gen(function* () {
      const after = yield* input.orchestrator.getLatestEventSequence();
      yield* input.evaluations
        .enqueueSettledSubagentRefreshes()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not refresh settled subagent evaluations", { cause }),
          ),
        );
      yield* Stream.runForEach(input.orchestrator.streamDomainEventsAfter(after), (event) => {
        const run = settledSubagentRun(event);
        if (run === undefined) return Effect.void;
        return input.evaluations.enqueueSettledSubagentRefreshes({ runId: run.runId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not refresh a settled subagent evaluation", {
              threadId: run.threadId,
              runId: run.runId,
              cause,
            }),
          ),
        );
      });
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("settled subagent evaluation refresh stopped", { cause }),
      ),
      Effect.retry(subscriptionBackoff),
    );
  },
);

const make = Effect.gen(function* () {
  const evaluations = yield* ModelEvaluations.ModelEvaluations;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const start: ModelEvaluationSubagentRefresh["Service"]["start"] = () =>
    forkParked(followSettledSubagentRefreshes({ evaluations, orchestrator }));

  return { start } satisfies ModelEvaluationSubagentRefresh["Service"];
});

export const layer = Layer.effect(ModelEvaluationSubagentRefresh, make);
