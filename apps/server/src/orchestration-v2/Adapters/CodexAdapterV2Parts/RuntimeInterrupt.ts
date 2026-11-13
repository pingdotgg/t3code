import { pipe } from "effect/Function";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, toProtocolError } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { getNativeThreadId, isDescendantCodexTurn, type ActiveCodexTurnContext } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";
import type { ProjectGeneratedImagesPart } from "./ProjectGeneratedImages.ts";
import type { MakeRootTerminalEventPart } from "./MakeRootTerminalEvent.ts";
import type { FinalizeCodexTurnPart } from "./FinalizeCodexTurn.ts";
import type { RetryCapacityFailurePart } from "./RetryCapacityFailure.ts";
import type { RuntimeThreadControlPart } from "./RuntimeThreadControl.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart & MakeRootTerminalEventPart & FinalizeCodexTurnPart & RetryCapacityFailurePart & RuntimeThreadControlPart;

export const installRuntimeInterrupt = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, capacityContinuations, clearImageWork, client, finalizeCodexTurn, goalStops, input, interruptingNativeTurns, latestRunTurnId, releaseSettledTurnIfIdle, resolveGoalStopTarget, runningCommandItemsByTurn, settledTurns, terminalizeMcpAppCaptures, terminalizeRunningCommandItems, terminalizeRunningDynamicTools, terminateBackgroundTerminal, turnTerminalizationPermit, turnWaiters } = deps;

const runtimeInterrupt: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "interruptTurn"> = {
        interruptTurn: Effect.fn("CodexAdapterV2.interruptTurn")(
          function* (requestedInput) {
            const nativeThreadId = requestedInput.providerThread.nativeThreadRef?.nativeId;
            const capacityRetry =
              nativeThreadId == null
                ? undefined
                : capacityContinuations.get(nativeThreadId)?.context;
            const startingRetry =
              capacityRetry?.providerTurnId === latestRunTurnId(requestedInput.providerTurnId)
                ? capacityRetry
                : undefined;
            if (startingRetry?.capacityRetryPending !== undefined) {
              const started = yield* Deferred.await(startingRetry.capacityRetryPending).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              if (Option.isNone(started))
                return yield* toProtocolError(
                  "Codex did not start the capacity retry within 10 seconds; Stop could not be delivered.",
                );
            }
            const { turnInput, goalTurns } = yield* resolveGoalStopTarget(requestedInput);
            const [activeTurnContexts, settledTurnContexts] =
              yield* turnTerminalizationPermit.withPermits(1)(
                Effect.gen(function* () {
                  return [
                    Array.from((yield* Ref.get(activeTurns)).values()),
                    Array.from((yield* Ref.get(settledTurns)).values()),
                  ] as const;
                }),
              );
            const activeTurn =
              activeTurnContexts.find(
                (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
              ) ??
              (turnInput.requestRuntimeRestart === true
                ? settledTurnContexts.find(
                    (candidate) => candidate.providerThread.id === turnInput.providerThread.id,
                  )
                : undefined);
            const lineageRoots = Array.from(
              new Set([
                ...(activeTurn === undefined ? [] : [activeTurn]),
                ...(startingRetry === undefined ? [] : [startingRetry]),
                ...goalTurns,
              ]),
            );
            const inLineage = (context: ActiveCodexTurnContext) =>
              lineageRoots.some(
                (root) => context === root || isDescendantCodexTurn(context, root),
              );
            const interruptTargetContexts = [
              ...(activeTurn === undefined ? [] : [activeTurn]),
              ...activeTurnContexts.filter(
                (candidate) => candidate !== activeTurn && inLineage(candidate),
              ),
              ...settledTurnContexts.filter(
                (candidate) =>
                  candidate !== activeTurn &&
                  ((turnInput.requestRuntimeRestart === true &&
                    candidate.providerThread.id === turnInput.providerThread.id) ||
                    inLineage(candidate)),
              ),
            ];
            if (interruptTargetContexts.length === 0) {
              if (turnInput.requestRuntimeRestart === true) return;
              return yield* toProtocolError(
                `Provider turn ${turnInput.providerTurnId} is not active and cannot be interrupted.`,
              );
            }
            const interruptTargets: Array<{
              readonly context: ActiveCodexTurnContext;
              readonly completion: Deferred.Deferred<void, never>;
            }> = [];
            for (const context of interruptTargetContexts) {
              interruptTargets.push({ context, completion: yield* Deferred.make<void>() });
            }
            yield* Ref.update(turnWaiters, (current) => {
              const updated = new Map(current);
              for (const target of interruptTargets) {
                updated.set(target.context.nativeTurnId, target.completion);
              }
              return updated;
            });
            yield* Ref.update(interruptingNativeTurns, (current) => {
              const updated = new Set(current);
              for (const target of interruptTargets) {
                updated.add(target.context.nativeTurnId);
              }
              return updated;
            });
            const registeredActiveTurns = yield* Ref.get(activeTurns);
            for (const target of interruptTargets) {
              if (registeredActiveTurns.get(target.context.nativeTurnId) !== target.context) {
                yield* Deferred.succeed(target.completion, undefined);
              }
            }

            const cleanupInterruptState = Effect.gen(function* () {
              yield* Ref.update(turnWaiters, (current) => {
                const updated = new Map(current);
                for (const target of interruptTargets) {
                  updated.delete(target.context.nativeTurnId);
                }
                return updated;
              });
              yield* Ref.update(interruptingNativeTurns, (current) => {
                const updated = new Set(current);
                for (const target of interruptTargets) {
                  updated.delete(target.context.nativeTurnId);
                }
                return updated;
              });
              yield* Ref.update(runningCommandItemsByTurn, (current) => {
                const updated = new Map(current);
                for (const target of interruptTargets) {
                  if (settledTurnContexts.includes(target.context)) continue;
                  updated.delete(target.context.nativeTurnId);
                }
                return updated;
              });
            });

            const trackedInterruptNativeTurnIds = new Set(
              interruptTargets.map((target) => target.context.nativeTurnId),
            );
            const finalizeRemainingInterruptLineage = Effect.gen(function* () {
              while (true) {
                const newlyDiscovered: Array<ActiveCodexTurnContext> = [];
                const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                      inLineage,
                    );
                    for (const context of lineage) {
                      if (trackedInterruptNativeTurnIds.has(context.nativeTurnId)) {
                        continue;
                      }
                      const completion = yield* Deferred.make<void>();
                      interruptTargets.push({ context, completion });
                      trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                      newlyDiscovered.push(context);
                      yield* Ref.update(turnWaiters, (current) => {
                        const updated = new Map(current);
                        updated.set(context.nativeTurnId, completion);
                        return updated;
                      });
                      yield* Ref.update(interruptingNativeTurns, (current) => {
                        const updated = new Set(current);
                        updated.add(context.nativeTurnId);
                        return updated;
                      });
                    }
                    return lineage;
                  }),
                );
                if (activeLineage.length === 0) {
                  return;
                }
                if (newlyDiscovered.length > 0) {
                  const completed = yield* Effect.forEach(
                    newlyDiscovered,
                    (context) =>
                      Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                        client.request("turn/interrupt", {
                          threadId,
                          turnId: context.nativeTurnId,
                        }),
                      ).pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.codex-remaining-lineage-interrupt-failed",
                            {
                              nativeTurnId: context.nativeTurnId,
                              providerSessionId: input.providerSessionId,
                              cause,
                            },
                          ),
                        ),
                      ),
                    { concurrency: "unbounded", discard: true },
                  ).pipe(Effect.timeoutOption("10 seconds"));
                  if (Option.isNone(completed)) {
                    yield* Effect.logWarning(
                      "orchestration-v2.codex-remaining-lineage-interrupt-timeout",
                      {
                        nativeTurnIds: newlyDiscovered.map((context) => context.nativeTurnId),
                        providerSessionId: input.providerSessionId,
                      },
                    );
                  }
                }
                const completedAt = yield* DateTime.now;
                for (const context of activeLineage) {
                  yield* finalizeCodexTurn({
                    context,
                    nativeTurnId: context.nativeTurnId,
                    status: "interrupted",
                    completedAt,
                  });
                }
              }
            });

            const interruptLateDescendants = Effect.gen(function* () {
              const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                Effect.gen(function* () {
                  const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                    (context) =>
                      !lineageRoots.includes(context) &&
                      inLineage(context) &&
                      !trackedInterruptNativeTurnIds.has(context.nativeTurnId),
                  );
                  for (const context of lineage) {
                    const completion = yield* Deferred.make<void>();
                    interruptTargets.push({ context, completion });
                    trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                    yield* Ref.update(turnWaiters, (current) => {
                      const updated = new Map(current);
                      updated.set(context.nativeTurnId, completion);
                      return updated;
                    });
                    yield* Ref.update(interruptingNativeTurns, (current) => {
                      const updated = new Set(current);
                      updated.add(context.nativeTurnId);
                      return updated;
                    });
                  }
                  return lineage;
                }),
              );
              const completed = yield* Effect.forEach(
                activeLineage,
                (context) =>
                  Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                    client.request("turn/interrupt", {
                      threadId,
                      turnId: context.nativeTurnId,
                    }),
                  ),
                { concurrency: "unbounded", discard: true },
              ).pipe(Effect.timeoutOption("10 seconds"));
              if (Option.isNone(completed)) {
                yield* Effect.logWarning(
                  "orchestration-v2.codex-late-descendant-interrupt-timeout",
                  {
                    nativeTurnIds: activeLineage.map((context) => context.nativeTurnId),
                    providerSessionId: input.providerSessionId,
                  },
                );
              }
            });

            yield* Effect.gen(function* () {
              for (const target of interruptTargets) {
                const context = target.context;
                if (context.capacityRetryPending !== undefined) {
                  yield* finalizeCodexTurn({
                    context,
                    nativeTurnId: context.nativeTurnId,
                    status: "interrupted",
                    completedAt: yield* DateTime.now,
                  });
                  continue;
                }
                // Null start timestamps ACK queued turns; interruption must wait for turn/started.
                if (context.nativeStartReady !== undefined) {
                  const ready = yield* Deferred.await(context.nativeStartReady).pipe(
                    Effect.timeoutOption("10 seconds"),
                  );
                  if (Option.isNone(ready)) {
                    return yield* toProtocolError(
                      "Codex did not start the queued turn within 10 seconds; Stop could not be delivered.",
                    );
                  }
                }
                if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                  continue;
                }
                yield* client.request("turn/interrupt", {
                  threadId: yield* getNativeThreadId(context.providerThread),
                  turnId: context.nativeTurnId,
                });
              }
              const containedTerminalKeys = new Set<string>();
              const attemptedTerminalKeys = new Set<string>();
              const collectTrackedTerminals = Effect.fn("CodexAdapterV2.collectTrackedTerminals")(
                function* (targets: typeof interruptTargets) {
                  const trackedTerminals = new Map<
                    string,
                    { readonly nativeThreadId: string; readonly processId: string }
                  >();
                  const runningItems = yield* Ref.get(runningCommandItemsByTurn);
                  for (const target of targets) {
                    const nativeThreadId = yield* getNativeThreadId(
                      target.context.providerThread,
                    );
                    const items = runningItems.get(target.context.nativeTurnId);
                    for (const item of items?.values() ?? []) {
                      if (item.processId !== undefined) {
                        trackedTerminals.set(`${nativeThreadId}:${item.processId}`, {
                          nativeThreadId,
                          processId: item.processId,
                        });
                      }
                    }
                  }
                  return trackedTerminals;
                },
              );
              const terminateTrackedTerminals = Effect.fn(
                "CodexAdapterV2.terminateTrackedTerminals",
              )(function* (targets: typeof interruptTargets) {
                const trackedTerminals = yield* collectTrackedTerminals(targets);
                const pendingTerminals = Array.from(trackedTerminals.entries())
                  .filter(([key]) => !containedTerminalKeys.has(key))
                  .sort(
                    ([leftKey], [rightKey]) =>
                      Number(attemptedTerminalKeys.has(leftKey)) -
                      Number(attemptedTerminalKeys.has(rightKey)),
                  );
                return yield* Effect.forEach(
                  pendingTerminals,
                  ([key, { nativeThreadId, processId }]) =>
                    Effect.gen(function* () {
                      attemptedTerminalKeys.add(key);
                      yield* terminateBackgroundTerminal(nativeThreadId, processId);
                      containedTerminalKeys.add(key);
                    }).pipe(
                      Effect.as({ success: true as const }),
                      Effect.catch((error) => Effect.succeed({ success: false as const, error })),
                    ),
                );
              });

              const [, completed] = yield* Effect.all(
                [
                  terminateTrackedTerminals(interruptTargets),
                  Effect.forEach(
                    interruptTargets,
                    (target) => Deferred.await(target.completion),
                    { concurrency: "unbounded", discard: true },
                  ).pipe(Effect.timeoutOption("10 seconds")),
                ],
                { concurrency: "unbounded" },
              );
              if (Option.isNone(completed)) {
                for (const target of interruptTargets) {
                  const context = target.context;
                  if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                    continue;
                  }
                  yield* Effect.logWarning("orchestration-v2.codex-interrupt-timeout", {
                    providerSessionId: input.providerSessionId,
                    providerThreadId: context.providerThread.id,
                    providerTurnId: context.providerTurnId,
                    nativeTurnId: context.nativeTurnId,
                  });
                }
              }

              yield* interruptLateDescendants;
              yield* finalizeRemainingInterruptLineage;

              const terminationResults = yield* terminateTrackedTerminals(interruptTargets);
              const failedTermination = terminationResults.find((result) => !result.success);
              if (failedTermination !== undefined && !failedTermination.success) {
                return yield* failedTermination.error;
              }
              yield* turnTerminalizationPermit.withPermits(1)(
                Effect.gen(function* () {
                  const completedAt = yield* DateTime.now;
                  for (const target of interruptTargets) {
                    const context = target.context;
                    if ((yield* Ref.get(settledTurns)).get(context.nativeTurnId) !== context)
                      continue;
                    yield* terminalizeRunningCommandItems(
                      context,
                      context.nativeTurnId,
                      "interrupted",
                      completedAt,
                    );
                    yield* terminalizeRunningDynamicTools(
                      context,
                      context.nativeTurnId,
                      "interrupted",
                      completedAt,
                      true,
                    );
                    yield* terminalizeMcpAppCaptures(context, context.nativeTurnId);
                    yield* Ref.update(runningCommandItemsByTurn, (current) => {
                      const updated = new Map(current);
                      updated.delete(context.nativeTurnId);
                      return updated;
                    });
                    yield* clearImageWork(context);
                    yield* releaseSettledTurnIfIdle(context.nativeTurnId);
                  }
                }),
              );
            }).pipe(
              Effect.onError(() => finalizeRemainingInterruptLineage),
              Effect.ensuring(cleanupInterruptState),
            );
          },
          (effect, requestedInput) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                const nativeThreadId = requestedInput.providerThread.nativeThreadRef?.nativeId;
                if (nativeThreadId != null)
                  goalStops.set(nativeThreadId, (goalStops.get(nativeThreadId) ?? 0) + 1);
                return nativeThreadId;
              }),
              () => effect,
              (nativeThreadId) =>
                Effect.sync(() => {
                  if (nativeThreadId == null) return;
                  const stops = (goalStops.get(nativeThreadId) ?? 1) - 1;
                  if (stops > 0) goalStops.set(nativeThreadId, stops);
                  else goalStops.delete(nativeThreadId);
                }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: requestedInput.providerThread.id,
                    providerTurnId: requestedInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
      };

  return { runtimeInterrupt };
});

export type RuntimeInterruptPart = ReturnType<typeof installRuntimeInterrupt> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installRuntimeInterrupt>;
