import {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  decideProviderSessionTransition,
  type ProviderSessionTransition,
} from "./ProviderSessionTransitionPolicy.ts";

export interface ProviderSwitchPlanV2 {
  readonly instanceChanged: boolean;
  readonly modelChanged: boolean;
  readonly targetProviderThreadId: ProviderThreadId | null;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId>;
  readonly transition: ProviderSessionTransition;
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

export const layer: Layer.Layer<
  ProviderSwitchServiceV2,
  never,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(
  ProviderSwitchServiceV2,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    return ProviderSwitchServiceV2.of({
      plan: ({ projection, targetModelSelection }) =>
        Effect.gen(function* () {
          const current = projection.thread.modelSelection;
          const instanceChanged = current.instanceId !== targetModelSelection.instanceId;
          const modelChanged = current.model !== targetModelSelection.model;
          const getMetadata = (instanceId: typeof current.instanceId) =>
            adapters.getMetadata !== undefined
              ? adapters.getMetadata(instanceId)
              : adapters.get(instanceId).pipe(
                  Effect.flatMap((adapter) =>
                    adapter.getCapabilities().pipe(
                      Effect.map((capabilities) => ({
                        driver: adapter.driver,
                        continuationKey: `${adapter.driver}:instance:${instanceId}`,
                        enabled: true,
                        capabilities,
                      })),
                    ),
                  ),
                );
          const currentInstance = yield* Effect.option(getMetadata(current.instanceId));
          const targetInstance = yield* Effect.option(getMetadata(targetModelSelection.instanceId));
          const targetAdapter = yield* Effect.option(adapters.get(targetModelSelection.instanceId));
          const currentSession = projection.providerSessions
            .filter((session) => session.providerInstanceId === current.instanceId)
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            )[0];
          const selectionTransition =
            current.instanceId === targetModelSelection.instanceId &&
            !modelSelectionsEqual(current, targetModelSelection) &&
            Option.isSome(targetAdapter) &&
            currentSession !== undefined
              ? yield* targetAdapter.value.planSelectionTransition({
                  current,
                  target: targetModelSelection,
                  sessionCapabilities: currentSession.capabilities,
                })
              : undefined;
          const transition =
            Option.isNone(targetInstance) || Option.isNone(targetAdapter)
              ? ({
                  type: "reject",
                  reason: "The target provider instance is unavailable.",
                } as const)
              : decideProviderSessionTransition({
                  current:
                    Option.isNone(currentInstance) || currentSession === undefined
                      ? null
                      : {
                          driver: currentInstance.value.driver,
                          continuationIdentity: {
                            driverKind: currentInstance.value.driver,
                            continuationKey: currentInstance.value.continuationKey,
                          },
                          modelSelection: current,
                          runtimeMode: projection.thread.runtimeMode,
                          interactionMode: projection.thread.interactionMode,
                          workspace: currentSession.cwd,
                          capabilities: currentSession.capabilities,
                        },
                  target: {
                    driver: targetInstance.value.driver,
                    continuationIdentity: {
                      driverKind: targetInstance.value.driver,
                      continuationKey: targetInstance.value.continuationKey,
                    },
                    modelSelection: targetModelSelection,
                    runtimeMode: projection.thread.runtimeMode,
                    interactionMode: projection.thread.interactionMode,
                    workspace:
                      projection.thread.worktreePath ??
                      currentSession?.cwd ??
                      "<unresolved-workspace>",
                    capabilities: targetInstance.value.capabilities,
                    available: targetInstance.value.enabled,
                  },
                  ...(selectionTransition === undefined ? {} : { selectionTransition }),
                });
          if (transition.type === "reject") {
            return yield* new ProviderSwitchPlanError({
              threadId: projection.thread.id,
              targetProviderInstanceId: targetModelSelection.instanceId,
              cause: transition.reason,
            });
          }
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
              if (transition.type === "restart_and_resume") {
                return session.id === currentSession?.id;
              }
              if (transition.type === "create_with_handoff") {
                return session.providerInstanceId !== targetModelSelection.instanceId;
              }
              return false;
            })
            .map((session) => session.id);
          return {
            instanceChanged,
            modelChanged,
            targetProviderThreadId: targetProviderThread?.id ?? null,
            releaseProviderSessionIds,
            transition,
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
    });
  }),
);
