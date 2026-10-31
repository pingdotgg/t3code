import {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SkillUsage from "../skills/SkillUsageService.ts";
import * as SkillVariants from "../skills/SkillVariantService.ts";
import { contaminatingSkillContexts } from "../skills/skillContextContamination.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  decideProviderSessionTransition,
  type ProviderSessionTransition,
} from "./ProviderSessionTransitionPolicy.ts";

export interface ProviderSwitchPlanV2 {
  readonly instanceChanged: boolean;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId>;
  readonly transition: ProviderSessionTransition;
}

export class ProviderSwitchPlanError extends Schema.TaggedError<ProviderSwitchPlanError>()(
  "ProviderSwitchPlanError",
  {
    threadId: ThreadId,
    targetProviderInstanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderSwitchServiceV2Shape {
  readonly plan: (input: {
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "providerSessions" | "providerThreads"
    >;
    readonly targetModelSelection: ModelSelection;
  }) => Effect.Effect<ProviderSwitchPlanV2, ProviderSwitchPlanError>;
}

export class ProviderSwitchServiceV2 extends Context.Service<
  ProviderSwitchServiceV2,
  ProviderSwitchServiceV2Shape
>()("t3/orchestration-v2/ProviderSwitchService/ProviderSwitchServiceV2") {}

const isLiveProviderSession = (
  session: OrchestrationV2ThreadProjection["providerSessions"][number],
) => session.status !== "stopped" && session.status !== "error";

export const layer: Layer.Layer<
  ProviderSwitchServiceV2,
  never,
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | SkillUsage.SkillUsageService
  | SkillVariants.SkillVariantService
> = Layer.effect(
  ProviderSwitchServiceV2,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const skillUsage = yield* SkillUsage.SkillUsageService;
    const skillVariants = yield* SkillVariants.SkillVariantService;
    return ProviderSwitchServiceV2.of({
      plan: Effect.fn("ProviderSwitchService.plan")(
        function* ({ projection, targetModelSelection }) {
          const current = projection.thread.modelSelection;
          const instanceChanged = current.instanceId !== targetModelSelection.instanceId;
          const selectionChanged = !modelSelectionsEqual(current, targetModelSelection);
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
          const currentSessions = projection.providerSessions
            .filter((session) => session.providerInstanceId === current.instanceId)
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            );
          const currentSession = currentSessions.find(isLiveProviderSession);
          const negotiatedCapabilities =
            currentSession?.capabilities ?? currentSessions[0]?.capabilities;
          const currentProviderThread = projection.providerThreads.find(
            (thread) =>
              thread.id === projection.thread.activeProviderThreadId &&
              thread.providerInstanceId === current.instanceId &&
              thread.nativeThreadRef !== null,
          );
          const selectionTransition =
            current.instanceId === targetModelSelection.instanceId &&
            selectionChanged &&
            Option.isSome(targetAdapter) &&
            Option.isSome(currentInstance) &&
            (currentSession !== undefined || currentProviderThread !== undefined)
              ? yield* targetAdapter.value.planSelectionTransition({
                  current,
                  target: targetModelSelection,
                  sessionCapabilities: negotiatedCapabilities ?? currentInstance.value.capabilities,
                })
              : undefined;
          const skillContextOmissions =
            currentProviderThread !== undefined &&
            Option.isSome(targetInstance) &&
            Option.isSome(targetAdapter)
              ? yield* Effect.gen(function* () {
                  const activated = yield* skillUsage.activatedOnProviderThread(
                    currentProviderThread.id,
                  );
                  if (activated.length === 0) return [];
                  const targetResolution = yield* skillVariants.resolvePolicy({
                    driver: targetInstance.value.driver,
                    model: targetModelSelection.model,
                    threadId: projection.thread.id,
                  });
                  return contaminatingSkillContexts({ activated, targetResolution });
                }).pipe(
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterrupts(cause),
                    (cause) =>
                      Effect.logWarning("Skill context contamination lookup failed", {
                        threadId: projection.thread.id,
                        providerThreadId: currentProviderThread.id,
                        cause,
                      }).pipe(Effect.as([])),
                  ),
                )
              : [];
          const transition =
            Option.isNone(targetInstance) || Option.isNone(targetAdapter)
              ? ({
                  type: "reject",
                  reason: "The target provider instance is unavailable.",
                } as const)
              : decideProviderSessionTransition({
                  current:
                    Option.isNone(currentInstance) ||
                    (currentSession === undefined && currentProviderThread === undefined)
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
                          workspace:
                            currentSession?.cwd ??
                            projection.thread.worktreePath ??
                            "<unresolved-workspace>",
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
                    available: targetInstance.value.enabled,
                  },
                  ...(selectionTransition === undefined ? {} : { selectionTransition }),
                  ...(skillContextOmissions.length === 0 ? {} : { skillContextOmissions }),
                });
          if (transition.type === "reject") {
            return yield* new ProviderSwitchPlanError({
              threadId: projection.thread.id,
              targetProviderInstanceId: targetModelSelection.instanceId,
              cause: transition.reason,
            });
          }
          const releaseProviderSessionIds = projection.providerSessions
            .filter((session) => {
              if (!isLiveProviderSession(session)) return false;
              if (transition.type === "restart_and_resume") {
                // Release only the replaced session; peers can serve pooled or delegated bindings.
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
            releaseProviderSessionIds,
            transition,
          };
        },
        (effect, { projection, targetModelSelection }) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSwitchPlanError({
                  threadId: projection.thread.id,
                  targetProviderInstanceId: targetModelSelection.instanceId,
                  cause,
                }),
            ),
          ),
      ),
    });
  }),
);
