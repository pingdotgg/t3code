import { pipe } from "effect/Function";
import { completeCodexTurnTokenUsage } from "../../../provider/CodexTurnTokenUsage.ts";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Ref from "effect/Ref";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_GOAL_CONTINUATION_GRACE, buildCodexTurnStartParams, codexRetryTurnItem, getNativeThreadId, providerGoalFromCodex, type ActiveCodexProviderRetry, type ActiveCodexTurnContext, type CodexErrorInfo, type CodexRootTerminalEvent } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import { CODEX_PROVIDER, codexNativeSubagentDetail, codexNativeSubagentLabel, codexTimestamp, providerTurnStatusToTerminal } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";
import type { EmitRootTerminalPart } from "./EmitRootTerminal.ts";
import type { ProjectGeneratedImagesPart } from "./ProjectGeneratedImages.ts";
import type { MakeRootTerminalEventPart } from "./MakeRootTerminalEvent.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart & EmitRootTerminalPart & ProjectGeneratedImagesPart & MakeRootTerminalEventPart;

export const installFinalizeCodexTurn = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, adapterOptions, additionalContextByThread, agentMessageDeltas, capacityContinuations, clearImageWork, client, completedFinalAnswerTextsByTurn, continuationRequests, continuedRuns, deferredRootTerminals, emitCompactionItem, emitGoalUpdate, emitImageWorkState, emitProviderEvent, emitRootTerminal, emitSubagentTaskUpdate, finalAnswerItemIdsByTurn, goalActivations, goalHolds, goalStops, goalsByNativeThread, imageTurns, input, interruptingNativeTurns, isContinuedRunDescendant, makeRootTerminalEvent, mcpSessions, pendingRootTurns, planDeltas, projectGeneratedImages, providerRetries, reasoningDeltas, reasoningParts, registerRootTurn, releaseGoalHold, releaseSettledTurnIfIdle, reportedTurnModel, runningCommandItemsByTurn, runningDynamicToolsByTurn, scope, settleGoalHold, settledTurns, terminalizeMcpAppCaptures, terminalizeRunningCommandItems, terminalizeRunningDynamicTools, terminalizedNonCompletedNativeTurns, turnHasRetainedBackgroundWork, turnTerminalizationPermit, turnWaiters, usageStateForThread } = deps;

const emitOrDeferRootTerminal = Effect.fn("CodexAdapterV2.emitOrDeferRootTerminal")(
        function* (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeTurnId: string;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly failureMessage?: string;
          readonly failureErrorInfo?: CodexErrorInfo;
          readonly providerRetry?: ActiveCodexProviderRetry;
          readonly goalHoldTurn?: OrchestrationV2ProviderTurn;
        }) {
          const event = yield* makeRootTerminalEvent(input);
          const hasActiveDescendants = Array.from((yield* Ref.get(activeTurns)).values()).some(
            (candidate) => isContinuedRunDescendant(candidate, input.context),
          );
          // Failed roots leave native children working and must settle without them.
          // Interrupted roots wait for descendants because Stop interrupts the whole lineage.
          if (event.status === "failed" && hasActiveDescendants) {
            yield* emitRootTerminal(input.context, { ...event, childTurnsContinue: true });
            return;
          }
          if (event.status !== "completed" && hasActiveDescendants) {
            yield* Ref.update(deferredRootTerminals, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeTurnId, { context: input.context, event });
              return updated;
            });
            return;
          }
          const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
          if (
            input.goalHoldTurn !== undefined &&
            event.status === "completed" &&
            nativeThreadId != null
          ) {
            goalHolds.set(nativeThreadId, {
              context: input.context,
              event,
              completedTurn: input.goalHoldTurn,
              next: yield* Deferred.make<ActiveCodexTurnContext | undefined>(),
            });
            yield* Effect.sleep(CODEX_GOAL_CONTINUATION_GRACE).pipe(
              Effect.andThen(pauseUncontinuedGoal(nativeThreadId, event)),
              Effect.andThen(
                turnTerminalizationPermit.withPermits(1)(releaseGoalHold(nativeThreadId, event)),
              ),
              // The grace window starts when the turn completes, not when the fiber is scheduled.
              Effect.forkIn(scope, { startImmediately: true }),
            );
            return;
          }
          yield* emitRootTerminal(input.context, event);
        },
      );

const pauseUncontinuedGoal = Effect.fnUntraced(function* (
        nativeThreadId: string,
        expected: CodexRootTerminalEvent,
      ) {
        const hold = goalHolds.get(nativeThreadId);
        if (
          hold?.event !== expected ||
          goalStops.has(nativeThreadId) ||
          goalsByNativeThread.get(nativeThreadId)?.status !== "active"
        ) {
          return;
        }
        goalHolds.delete(nativeThreadId);
        // Keeps a turn Codex starts before settlement an orphan once the goal reads paused.
        goalStops.set(nativeThreadId, (goalStops.get(nativeThreadId) ?? 0) + 1);
        yield* Effect.logWarning("orchestration-v2.codex-goal-continuation-expired", {
          nativeThreadId,
        });
        yield* client
          .request("thread/goal/set", { threadId: nativeThreadId, status: "paused" })
          .pipe(
            // The hold is already claimed, so an unanswered pause must not keep the run open.
            Effect.timeout("10 seconds"),
            Effect.flatMap(({ goal }) => {
              goalsByNativeThread.set(nativeThreadId, providerGoalFromCodex(goal));
              return emitGoalUpdate(nativeThreadId);
            }),
            Effect.catch((cause) =>
              Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
            ),
            Effect.ensuring(
              turnTerminalizationPermit.withPermits(1)(settleGoalHold(hold, "completed")),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                const stops = (goalStops.get(nativeThreadId) ?? 1) - 1;
                if (stops > 0) goalStops.set(nativeThreadId, stops);
                else goalStops.delete(nativeThreadId);
              }),
            ),
          );
      });

const flushReadyRootTerminals = Effect.fn("CodexAdapterV2.flushReadyRootTerminals")(
        function* () {
          const activeTurnContexts = Array.from((yield* Ref.get(activeTurns)).values());
          const readyEvents = yield* Ref.modify(deferredRootTerminals, (current) => {
            const updated = new Map(current);
            const ready: Array<{
              context: ActiveCodexTurnContext;
              event: CodexRootTerminalEvent;
            }> = [];
            for (const [nativeTurnId, deferred] of current) {
              if (
                !activeTurnContexts.some((candidate) =>
                  isContinuedRunDescendant(candidate, deferred.context),
                )
              ) {
                updated.delete(nativeTurnId);
                ready.push(deferred);
              }
            }
            return [ready, updated] as const;
          });
          for (const ready of readyEvents) {
            yield* emitRootTerminal(ready.context, ready.event);
          }
        },
      );

const finalizeCodexTurn = (input: {
        readonly context: ActiveCodexTurnContext;
        readonly nativeTurnId: string;
        readonly status: OrchestrationV2ProviderTurn["status"];
        readonly completedAt: DateTime.Utc;
        readonly failureMessage?: string;
        readonly failureErrorInfo?: CodexErrorInfo;
        readonly continueRun?: boolean;
      }) =>
        // Capacity continuation already holds the permit across finalization and restart.
        (input.continueRun ? Function.identity : turnTerminalizationPermit.withPermits(1))(
          Effect.gen(function* () {
            const current = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
            if (current !== input.context) {
              return false;
            }
            input.context.fileChangeKindsByItem.clear();
            const providerRetry = yield* Ref.modify(providerRetries, (current) => {
              const retry = current.get(input.context.providerTurnId);
              if (retry === undefined) {
                return [undefined, current] as const;
              }
              const updated = new Map(current);
              updated.delete(input.context.providerTurnId);
              return [retry, updated] as const;
            });
            if (
              providerRetry !== undefined &&
              !input.continueRun &&
              (providerRetry.context !== undefined ||
                input.status !== "failed" ||
                input.context.subagent !== null)
            ) {
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: codexRetryTurnItem(
                  input.context,
                  providerRetry,
                  input.status === "failed" &&
                    providerRetry.context !== input.context &&
                    providerRetry.context !== undefined
                    ? "interrupted"
                    : providerTurnStatusToTerminal(input.status),
                  input.completedAt,
                ),
              });
            }
            if (input.status !== "completed" && !input.continueRun) {
              yield* Ref.update(terminalizedNonCompletedNativeTurns, (current) => {
                const updated = new Set(current);
                for (const turn of continuedRuns.get(input.context.providerTurnId) ?? [
                  input.context,
                ])
                  updated.add(turn.nativeTurnId);
                return updated;
              });
            }
            yield* agentMessageDeltas.flushTurn(input.nativeTurnId);
            yield* reasoningDeltas.flushTurn(input.nativeTurnId);
            yield* planDeltas.flushTurn(input.nativeTurnId);
            for (const [key, part] of reasoningParts) {
              if (part.turnId === input.nativeTurnId) reasoningParts.delete(key);
            }
            // Failed compaction can end the turn without item/completed.
            for (const nativeItemId of input.context.runningCompactionItemIds) {
              yield* emitCompactionItem(
                input.context,
                nativeItemId,
                providerTurnStatusToTerminal(input.status),
                input.completedAt,
              );
            }
            yield* projectGeneratedImages(input.context, input.nativeTurnId);
            if (input.status !== "completed") {
              yield* clearImageWork(input.context);
            } else {
              const images = imageTurns.get(input.nativeTurnId);
              if (images !== undefined) {
                yield* emitImageWorkState(input.context, images.running.size > 0);
              }
            }
            const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
            const activation =
              nativeThreadId == null ? undefined : goalActivations.get(nativeThreadId);
            const holdsForGoal =
              input.context.subagent === null &&
              input.status === "completed" &&
              nativeThreadId != null &&
              (goalsByNativeThread.get(nativeThreadId)?.status === "active" ||
                (activation !== undefined && !activation.stopped));
            const completedTurn: OrchestrationV2ProviderTurn = {
              id: input.context.providerTurnId,
              providerThreadId: input.context.providerThread.id,
              nodeId: input.context.providerNodeId,
              runAttemptId:
                input.context.subagent === null ? input.context.input.attemptId : null,
              nativeTurnRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeTurnId,
                strength: "strong",
              },
              ordinal: input.context.providerTurnOrdinal,
              status: input.status,
              startedAt: input.context.startedAt,
              completedAt: input.completedAt,
              turnTokenUsage: completeCodexTurnTokenUsage(
                usageStateForThread(
                  input.context.providerThread.nativeThreadRef?.nativeId ??
                    String(input.context.providerThread.id),
                ),
                input.nativeTurnId,
                input.status === "completed",
                reportedTurnModel(
                  input.context.providerThread.nativeThreadRef?.nativeId ?? "",
                  input.nativeTurnId,
                ),
              ),
            };
            if (!holdsForGoal) {
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                driver: CODEX_PROVIDER,
                threadId: input.context.projectionThreadId,
                providerTurn: completedTurn,
              });
            }
            if (input.context.subagent !== null) {
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  id: input.context.providerNodeId,
                  threadId: input.context.projectionThreadId,
                  runId: null,
                  parentNodeId: null,
                  rootNodeId: input.context.rootNodeId,
                  kind: "root_turn",
                  status: input.status,
                  countsForRun: false,
                  providerThreadId: input.context.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  nativeItemRef: input.context.subagent.task.nativeTaskRef,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: input.context.providerNodeStartedAt,
                  completedAt: input.completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "provider_thread.updated",
                driver: CODEX_PROVIDER,
                providerThread: {
                  ...input.context.providerThread,
                  status: "idle",
                  updatedAt: input.completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  id: input.context.subagent.subagentNodeId,
                  threadId: input.context.subagent.parentContext.projectionThreadId,
                  runId: input.context.subagent.parentContext.projectionRunId,
                  parentNodeId: input.context.subagent.parentContext.itemParentNodeId,
                  rootNodeId: input.context.subagent.parentContext.rootNodeId,
                  kind: "subagent",
                  status: input.status,
                  countsForRun: false,
                  providerThreadId: input.context.providerThread.id,
                  providerTurnId: input.context.subagent.parentContext.providerTurnId,
                  nativeItemRef: input.context.subagent.task.nativeTaskRef,
                  runtimeRequestId: null,
                  checkpointScopeId: null,
                  startedAt: input.context.subagent.startedAt,
                  completedAt: input.completedAt,
                },
              });
              yield* emitSubagentTaskUpdate({
                subagent: input.context.subagent,
                status: input.status,
                completedAt: input.completedAt,
              });
              // Codex does not wake a completed parent turn, leaving child results unread.
              // Only direct children wake an idle root turn; grandchildren report to their
              // own parent, and running root turns receive results natively.
              const parent = input.context.subagent.parentContext;
              const parentNativeThreadId = parent.providerThread.nativeThreadRef?.nativeId;
              if (
                continuationRequests !== undefined &&
                parent.subagent === null &&
                (input.status === "completed" || input.status === "failed") &&
                !(yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(parent.nativeTurnId) &&
                (parentNativeThreadId == null ||
                  !capacityContinuations.has(parentNativeThreadId)) &&
                ![...(yield* Ref.get(activeTurns)).values()].some(
                  (active) =>
                    active.subagent === null &&
                    active.providerThread.id === parent.providerThread.id,
                )
              ) {
                const task = input.context.subagent.task;
                yield* continuationRequests.offer({
                  threadId: parent.projectionThreadId,
                  providerThreadId: parent.providerThread.id,
                  driver: CODEX_PROVIDER,
                  detail: codexNativeSubagentDetail(task),
                  // The detail is the whole wake; Codex buffers no output for it.
                  delivery: "message_text",
                  notification: backgroundWorkNotification([
                    {
                      kind: "subagent",
                      label: codexNativeSubagentLabel(task),
                      outcome: input.status,
                      childThreadId: input.context.subagent.childThreadId,
                    },
                  ]),
                });
              }
            }
            if (input.status === "interrupted" || input.status === "failed") {
              yield* terminalizeRunningCommandItems(
                input.context,
                input.nativeTurnId,
                input.status,
                input.completedAt,
              );
              yield* terminalizeMcpAppCaptures(input.context, input.nativeTurnId);
            }
            const dynamicToolStatus: "cancelled" | "interrupted" | "failed" =
              input.status === "interrupted" || input.status === "failed"
                ? input.status
                : "cancelled";
            yield* terminalizeRunningDynamicTools(
              input.context,
              input.nativeTurnId,
              dynamicToolStatus,
              input.completedAt,
              input.status === "interrupted" || input.status === "failed",
            );
            if (input.context.subagent === null && !input.continueRun) {
              yield* emitOrDeferRootTerminal({
                ...input,
                ...(providerRetry === undefined ? {} : { providerRetry }),
                ...(holdsForGoal ? { goalHoldTurn: completedTurn } : {}),
              });
            }
            const waiter = (yield* Ref.get(turnWaiters)).get(input.nativeTurnId);
            if (waiter !== undefined) {
              yield* Deferred.succeed(waiter, undefined);
            }
            const interruptInProgress = (yield* Ref.get(interruptingNativeTurns)).has(
              input.nativeTurnId,
            );
            const retainSettledContext =
              input.status === "completed" &&
              (yield* turnHasRetainedBackgroundWork(input.nativeTurnId));
            if (retainSettledContext) {
              yield* Ref.update(settledTurns, (current) => {
                const updated = new Map(current);
                updated.set(input.nativeTurnId, input.context);
                return updated;
              });
              // Recheck after recording settlement; background work may have finished before a settled turn existed to release.
              yield* releaseSettledTurnIfIdle(input.nativeTurnId);
            }
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.delete(input.nativeTurnId);
              return updated;
            });
            if (input.context.nativeStartReady !== undefined) {
              yield* Deferred.succeed(input.context.nativeStartReady, undefined);
            }
            if (!input.continueRun && input.context.capacityRetryPending !== undefined) {
              yield* Deferred.succeed(input.context.capacityRetryPending, undefined);
            }
            yield* flushReadyRootTerminals();
            if (!retainSettledContext && !interruptInProgress) {
              yield* Ref.update(runningCommandItemsByTurn, (current) => {
                if (!current.has(input.nativeTurnId)) {
                  return current;
                }
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
              yield* Ref.update(runningDynamicToolsByTurn, (current) => {
                if (!current.has(input.nativeTurnId)) {
                  return current;
                }
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
            }
            if (!retainSettledContext) {
              yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                if (!current.has(input.nativeTurnId)) {
                  return current;
                }
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
              imageTurns.delete(input.nativeTurnId);
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                if (!current.has(input.nativeTurnId)) {
                  return current;
                }
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
            }
            return true;
          }),
        );

const startNativeTurn = Effect.fn("CodexAdapterV2.startNativeTurn")(
        function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>,
        ) {
          const threadId = yield* getNativeThreadId(turnInput.providerThread);
          const mcpSession = yield* mcpSessions.read(turnInput.threadId);
          const turnStartParams = yield* buildCodexTurnStartParams({
            nativeThreadId: threadId,
            codexInput,
            runtimePolicy: turnInput.runtimePolicy,
            modelSelection: turnInput.modelSelection,
            hasT3Mcp: mcpSession !== undefined,
            browserToolsAvailable: mcpSession?.browserToolsAvailable ?? true,
            deviceToolsAvailable: mcpSession?.capabilities?.has("device") ?? false,
            omitServiceTier: adapterOptions.resolveRuntime !== undefined,
            ...(turnInput.appContext === undefined ? {} : { appContext: turnInput.appContext }),
          });
          yield* Ref.update(pendingRootTurns, (current) => {
            const updated = new Map(current);
            updated.set(threadId, turnInput);
            return updated;
          });
          yield* Ref.update(additionalContextByThread, (current) => {
            const next = new Map(current);
            if (turnStartParams.additionalContext)
              next.set(threadId, turnStartParams.additionalContext);
            else next.delete(threadId);
            return next;
          });
          // Completion can remove the old context while turn/start is in flight.
          const previousTurns = new Map([
            ...(yield* Ref.get(settledTurns)),
            ...(yield* Ref.get(activeTurns)),
          ]);
          const started = yield* client.request("turn/start", turnStartParams);
          const previousTurn =
            previousTurns.get(started.turn.id) ??
            (yield* Ref.get(activeTurns)).get(started.turn.id);
          if (
            previousTurn !== undefined &&
            previousTurn.input.attemptId !== turnInput.attemptId
          ) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CODEX_PROVIDER,
              detail:
                "Codex returned a turn belonging to an earlier run. Stop the existing turn before retrying this message.",
            });
          }
          // A turn/started notification may have registered and completed this turn already.
          if ((yield* Ref.get(pendingRootTurns)).get(threadId) !== turnInput) return;
          yield* registerRootTurn({
            turnInput,
            nativeTurnId: started.turn.id,
            startedAt: codexTimestamp(started.turn.startedAt),
            waitForNativeStart: started.turn.startedAt === null,
          });
        },
        (effect, turnInput) =>
          effect.pipe(
            Effect.ensuring(
              Effect.flatMap(getNativeThreadId(turnInput.providerThread), (threadId) =>
                Ref.update(pendingRootTurns, (current) => {
                  if (current.get(threadId) !== turnInput) return current;
                  const updated = new Map(current);
                  updated.delete(threadId);
                  return updated;
                }),
              ).pipe(Effect.ignore),
            ),
          ),
      );

  return { emitOrDeferRootTerminal, pauseUncontinuedGoal, flushReadyRootTerminals, finalizeCodexTurn, startNativeTurn };
});

export type FinalizeCodexTurnPart = ReturnType<typeof installFinalizeCodexTurn> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installFinalizeCodexTurn>;
