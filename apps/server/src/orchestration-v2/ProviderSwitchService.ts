import {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ProviderSwitchPlanV2 {
  readonly instanceChanged: boolean;
  readonly modelChanged: boolean;
  readonly targetProviderThreadId: ProviderThreadId | null;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId>;
}

export class ProviderSwitchPlanError extends Schema.TaggedErrorClass<ProviderSwitchPlanError>()(
  "ProviderSwitchPlanError",
  {
    threadId: ThreadId,
    targetProviderInstanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderSwitchServiceV2Shape {
  readonly plan: (input: {
    readonly projection: OrchestrationV2ThreadProjection;
    readonly targetModelSelection: ModelSelection;
  }) => Effect.Effect<ProviderSwitchPlanV2, ProviderSwitchPlanError>;
}

export class ProviderSwitchServiceV2 extends Context.Service<
  ProviderSwitchServiceV2,
  ProviderSwitchServiceV2Shape
>()("t3/orchestration-v2/ProviderSwitchService/ProviderSwitchServiceV2") {}

export const layer: Layer.Layer<ProviderSwitchServiceV2> = Layer.succeed(
  ProviderSwitchServiceV2,
  ProviderSwitchServiceV2.of({
    plan: ({ projection, targetModelSelection }) =>
      Effect.sync(() => {
        const current = projection.thread.modelSelection;
        const instanceChanged = current.instanceId !== targetModelSelection.instanceId;
        const modelChanged = current.model !== targetModelSelection.model;
        const targetProviderThread = projection.providerThreads
          .filter(
            (thread) =>
              thread.appThreadId === projection.thread.id &&
              thread.ownerNodeId === null &&
              thread.providerInstanceId === targetModelSelection.instanceId,
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          )[0];
        const releaseProviderSessionIds = projection.providerSessions
          .filter((session) => {
            if (session.status === "stopped" || session.status === "error") return false;
            if (instanceChanged) {
              return session.providerInstanceId !== targetModelSelection.instanceId;
            }
            return modelChanged && !session.capabilities.sessions.supportsModelSwitchInSession;
          })
          .map((session) => session.id);
        return {
          instanceChanged,
          modelChanged,
          targetProviderThreadId: targetProviderThread?.id ?? null,
          releaseProviderSessionIds,
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSwitchPlanError({
              threadId: projection.thread.id,
              targetProviderInstanceId: targetModelSelection.instanceId,
              cause,
            }),
        ),
      ),
  }),
);
