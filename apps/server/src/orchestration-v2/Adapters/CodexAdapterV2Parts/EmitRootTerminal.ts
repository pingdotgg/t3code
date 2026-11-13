import { pipe } from "effect/Function";
import { accumulateCodexTurnTokenUsage } from "../../../provider/CodexTurnTokenUsage.ts";
import { codexRateLimitsToUpdate, mergeCodexRateLimits, codexUsageLimitResetAt } from "../../../provider/codexUsageLimits.ts";
import type { OrchestrationV2ProviderRetry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { makeProviderFailure, makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import type { CodexAdapterScope } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, codexNativeItemRef, codexPlanStepStatus, codexProviderTurnTokenUsage, codexTimestamp, nonEmptyText, trimText } from "../CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { codexErrorInfoCode, codexRetryTurnItem, codexUsageLimitError, parseCodexRetryProgress, providerGoalFromCodex, type ActiveCodexProviderRetry, type ActiveCodexTurnContext, type CodexGoalHold, type CodexRootTerminalEvent, withCodexManagedFailure } from "../CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
import type { RegisterRootTurnPart } from "./RegisterRootTurn.ts";
import type { EmitSubagentProviderTurnStartedPart } from "./EmitSubagentProviderTurnStarted.ts";
import type { RegisterSubagentThreadPart } from "./RegisterSubagentThread.ts";
import type { BuildAgentMessageArtifactsPart } from "./BuildAgentMessageArtifacts.ts";
import type { BuildUserInputRequestArtifactsPart } from "./BuildUserInputRequestArtifacts.ts";

type Deps = CodexAdapterScope & RegisterRootTurnPart & EmitSubagentProviderTurnStartedPart & RegisterSubagentThreadPart & BuildAgentMessageArtifactsPart & BuildUserInputRequestArtifactsPart;

export const installEmitRootTerminal = Effect.fnUntraced(function* (deps: Deps) {
  const { activeTurns, adapterOptions, awaitActiveTurn, buildTodoListArtifacts, client, completeProviderRetry, continuedRuns, emitGoalUpdate, emitProviderEvent, goalHolds, goalStops, goalsByNativeThread, idAllocator, limitedTurnItems, now, pendingRootTurns, providerRetries, rateLimitSnapshot, registerRootTurn, releaseSettledTurnIfIdle, rememberSubagentTurnStarted, reroutedThreads, reroutedTurnModels, resolveItemOrdinal, resolveItemPosition, rootProviderThreads, runningCommandItemsByTurn, scope, settledTurns, terminalizeRunningCommandItems, terminalizedNonCompletedNativeTurns, turnTerminalizationPermit, updateSubagentSelection, usageStateForThread } = deps;

yield* client.handleServerNotification("turn/plan/updated", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return;
          }
          yield* completeProviderRetry(context, yield* DateTime.now);
          const steps = payload.plan.map((step, index) => ({
            id: `step-${index + 1}`,
            text: nonEmptyText(step.step, `Step ${index + 1}`),
            status: codexPlanStepStatus(step.status),
          }));
          const explanation = trimText(payload.explanation);
          const artifacts = yield* buildTodoListArtifacts({
            context,
            nativeItemId: `turn-plan:${payload.turnId}`,
            status: "active",
            ...(explanation === undefined ? {} : { explanation }),
            steps,
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver: CODEX_PROVIDER,
            plan: artifacts.plan,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
        }).pipe(Effect.orDie),
      );

yield* client.handleServerNotification("account/rateLimits/updated", (payload) =>
        Effect.gen(function* () {
          const previous = yield* Ref.getAndUpdate(rateLimitSnapshot, (previous) =>
            mergeCodexRateLimits(previous, payload.rateLimits),
          );
          const resetAt = codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot));
          for (const item of (yield* Ref.get(limitedTurnItems)).values()) {
            if (resetAt === null || item.failure.resetAt != null) continue;
            const updated = {
              ...item,
              updatedAt: yield* DateTime.now,
              failure: { ...item.failure, resetAt },
            };
            yield* Ref.update(limitedTurnItems, (current) =>
              new Map(current).set(item.providerThreadId!, updated),
            );
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: updated,
            });
          }
          const update = codexRateLimitsToUpdate(payload.rateLimits, previous);
          if (update && adapterOptions.onUsageLimits) {
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            yield* adapterOptions.onUsageLimits({ ...update, checkedAt });
          }
        }).pipe(Effect.orDie),
      );

yield* client.handleServerNotification("thread/tokenUsage/updated", (payload) =>
        Effect.gen(function* () {
          accumulateCodexTurnTokenUsage(
            usageStateForThread(payload.threadId),
            payload.turnId,
            payload.tokenUsage,
          );
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return;
          }
          const now = yield* DateTime.now;
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: context.projectionThreadId,
            providerTurn: {
              id: context.providerTurnId,
              providerThreadId: context.providerThread.id,
              nodeId: context.providerNodeId,
              runAttemptId: context.subagent === null ? context.input.attemptId : null,
              nativeTurnRef: {
                driver: CODEX_PROVIDER,
                nativeId: payload.turnId,
                strength: "strong",
              },
              ordinal: context.providerTurnOrdinal,
              status: "running",
              startedAt: context.startedAt,
              completedAt: null,
              tokenUsage: codexProviderTurnTokenUsage(
                payload.tokenUsage,
                DateTime.formatIso(now),
              ),
            },
          });
        }).pipe(Effect.orDie),
      );

yield* client.handleServerNotification("thread/settings/updated", (payload) =>
        Effect.sync(() => reroutedThreads.delete(payload.threadId)).pipe(
          Effect.andThen(
            updateSubagentSelection(
              payload.threadId,
              payload.threadSettings.model,
              payload.threadSettings.effort,
              payload.threadSettings.serviceTier,
            ),
          ),
        ),
      );

yield* client.handleServerNotification("model/rerouted", (payload) =>
        Effect.sync(() => {
          reroutedTurnModels.set(payload.turnId, payload.toModel);
          reroutedThreads.add(payload.threadId);
        }).pipe(Effect.andThen(updateSubagentSelection(payload.threadId, payload.toModel))),
      );

yield* client.handleServerNotification("hook/completed", (payload) =>
        Effect.gen(function* () {
          if (payload.turnId == null || payload.run.status !== "stopped") return;
          const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
          if (context?.providerThread.nativeThreadRef?.nativeId !== payload.threadId) return;
          const reason = payload.run.entries
            .filter((entry) => entry.kind === "stop")
            .map((entry) => entry.text.trim())
            .filter(Boolean)
            .join("\n");
          if (!reason) return;
          const source = payload.run.source === undefined ? "" : ` (${payload.run.source})`;
          context.hookStopReason = `${payload.run.eventName} hook${source}: ${reason}`;
        }),
      );

yield* client.handleServerNotification("turn/started", (payload) =>
        Effect.gen(function* () {
          const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
          if (context !== undefined) {
            if (context.nativeStartReady !== undefined) {
              yield* Deferred.succeed(context.nativeStartReady, undefined);
            }
            return;
          }
          const pendingRootTurn = (yield* Ref.get(pendingRootTurns)).get(payload.threadId);
          if (pendingRootTurn !== undefined) {
            yield* registerRootTurn({
              turnInput: pendingRootTurn,
              nativeTurnId: payload.turn.id,
              startedAt: codexTimestamp(payload.turn.startedAt),
            });
            yield* Ref.update(pendingRootTurns, (current) => {
              const updated = new Map(current);
              updated.delete(payload.threadId);
              return updated;
            });
            return;
          }
          const goalHold = goalHolds.get(payload.threadId);
          if (goalHold !== undefined) {
            goalHolds.delete(payload.threadId);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: goalHold.context.projectionThreadId,
              providerTurn: goalHold.completedTurn,
            });
            const next = yield* registerRootTurn({
              turnInput: {
                ...goalHold.context.input,
                providerTurnOrdinal: goalHold.context.providerTurnOrdinal + 1,
              },
              nativeTurnId: payload.turn.id,
              startedAt: codexTimestamp(payload.turn.startedAt),
            });
            const goalRun = continuedRuns.get(goalHold.context.providerTurnId) ?? [
              goalHold.context,
            ];
            goalRun.push(next);
            continuedRuns.set(goalHold.context.providerTurnId, goalRun);
            continuedRuns.set(next.providerTurnId, goalRun);
            yield* Deferred.succeed(goalHold.next, next);
            return;
          }
          // Pause orphan goal turns so they cannot work without an owning run.
          if (
            rootProviderThreads.has(payload.threadId) &&
            (goalsByNativeThread.get(payload.threadId)?.status === "active" ||
              goalStops.has(payload.threadId))
          ) {
            yield* Effect.logWarning("orchestration-v2.codex-goal-turn-without-run", {
              nativeThreadId: payload.threadId,
              nativeTurnId: payload.turn.id,
            });
            yield* client
              .request("thread/goal/set", { threadId: payload.threadId, status: "paused" })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                ),
                Effect.andThen(
                  client.request("turn/interrupt", {
                    threadId: payload.threadId,
                    turnId: payload.turn.id,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration-v2.codex-goal-turn-stop-failed", { cause }),
                ),
                Effect.forkIn(scope),
              );
            return;
          }
          yield* rememberSubagentTurnStarted({
            nativeThreadId: payload.threadId,
            nativeTurnId: payload.turn.id,
            startedAt: codexTimestamp(payload.turn.startedAt),
          });
        }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
      );

yield* client.handleServerNotification("thread/goal/updated", (payload) =>
        Effect.gen(function* () {
          goalsByNativeThread.set(payload.threadId, providerGoalFromCodex(payload.goal));
          yield* emitGoalUpdate(payload.threadId);
          if (payload.goal.status !== "active") yield* releaseGoalHold(payload.threadId);
        }).pipe(turnTerminalizationPermit.withPermits(1)),
      );

yield* client.handleServerNotification("thread/goal/cleared", (payload) =>
        Effect.gen(function* () {
          goalsByNativeThread.set(payload.threadId, null);
          yield* emitGoalUpdate(payload.threadId);
          yield* releaseGoalHold(payload.threadId);
        }).pipe(turnTerminalizationPermit.withPermits(1)),
      );

yield* client.handleServerNotification("error", (payload) =>
        Effect.gen(function* () {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined) {
            return;
          }
          const notificationCode = codexErrorInfoCode(payload.error.codexErrorInfo);
          if (!payload.willRetry) {
            context.latestProviderFailure = {
              nativeMessage: payload.error.message,
              nativeCode: notificationCode,
              failure: withCodexManagedFailure(
                makeProviderFailure({
                  message: payload.error.additionalDetails?.trim() || payload.error.message,
                  code: notificationCode,
                  class: codexUsageLimitError(notificationCode, payload.error.codexErrorInfo)
                    ? "usage_limit"
                    : "provider_error",
                }),
                payload.error,
              ),
            };
            return;
          }
          const updatedAt = yield* DateTime.now;
          const previous = (yield* Ref.get(providerRetries)).get(context.providerTurnId);
          const progress = parseCodexRetryProgress(payload.error.message);
          const retry: OrchestrationV2ProviderRetry = {
            attempt: progress?.attempt ?? (previous?.retry.attempt ?? 0) + 1,
            maxAttempts: progress?.maxAttempts ?? previous?.retry.maxAttempts ?? null,
            retryDelayMs: null,
          };
          const code = codexErrorInfoCode(payload.error.codexErrorInfo);
          const additionalDetails = payload.error.additionalDetails?.trim();
          const failure = withCodexManagedFailure(
            makeProviderFailure({
              message:
                additionalDetails === undefined || additionalDetails.length === 0
                  ? payload.error.message
                  : additionalDetails,
              code,
              class: codexUsageLimitError(code, payload.error.codexErrorInfo)
                ? "usage_limit"
                : code?.startsWith("http") === true || code?.startsWith("responseStream") === true
                  ? "transport_error"
                  : "provider_error",
              retryable: true,
            }),
            payload.error,
          );
          const itemOrdinal =
            previous?.itemOrdinal ??
            (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`));
          const state: ActiveCodexProviderRetry = {
            ...(previous?.context === undefined ? {} : { context: previous.context }),
            nativeMessage: payload.error.message,
            nativeCode: code,
            retry,
            failure,
            startedAt: previous?.startedAt ?? updatedAt,
            itemOrdinal,
          };
          yield* Ref.update(providerRetries, (current) => {
            const updated = new Map(current);
            updated.set(context.providerTurnId, state);
            return updated;
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: codexRetryTurnItem(context, state, "running", updatedAt),
          });
        }).pipe(Effect.orDie),
      );

const emitCompactionItem = Effect.fn("CodexAdapterV2.emitCompactionItem")(function* (
        context: ActiveCodexTurnContext,
        nativeItemId: string,
        status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        updatedAt: DateTime.Utc,
      ) {
        const { ordinal, startedAt } = yield* resolveItemPosition(
          context,
          nativeItemId,
          updatedAt,
        );
        if (status === "running") context.runningCompactionItemIds.add(nativeItemId);
        else context.runningCompactionItemIds.delete(nativeItemId);
        yield* emitProviderEvent({
          type: "turn_item.updated",
          driver: CODEX_PROVIDER,
          turnItem: {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId,
            }),
            threadId: context.projectionThreadId,
            runId: context.projectionRunId,
            nodeId: context.providerNodeId,
            providerThreadId: context.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef: codexNativeItemRef(nativeItemId),
            parentItemId: null,
            ordinal,
            type: "compaction",
            driver: CODEX_PROVIDER,
            status,
            title:
              status === "running"
                ? "Compacting context"
                : status === "completed"
                  ? "Context compacted"
                  : status === "failed"
                    ? "Context compaction failed"
                    : "Context compaction stopped",
            startedAt,
            completedAt: status === "running" ? null : updatedAt,
            updatedAt,
          },
        });
      });

yield* client.handleServerNotification("thread/closed", (payload) =>
        Effect.gen(function* () {
          const completedAt = yield* DateTime.now;
          for (const context of (yield* Ref.get(settledTurns)).values()) {
            if (context.providerThread.nativeThreadRef?.nativeId !== payload.threadId) continue;
            const commands = (yield* Ref.get(runningCommandItemsByTurn)).get(
              context.nativeTurnId,
            );
            if (commands !== undefined) {
              context.closedCommandItemIds = new Set(commands.keys());
            }
            yield* terminalizeRunningCommandItems(
              context,
              context.nativeTurnId,
              "interrupted",
              completedAt,
            );
            yield* Ref.update(runningCommandItemsByTurn, (current) => {
              const updated = new Map(current);
              updated.delete(context.nativeTurnId);
              return updated;
            });
            yield* releaseSettledTurnIfIdle(context.nativeTurnId);
          }
        }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
      );

const emitRootTerminal = Effect.fnUntraced(function* (
        context: ActiveCodexTurnContext,
        event: CodexRootTerminalEvent,
      ) {
        const current =
          event.status === "failed" && event.failure.class === "usage_limit"
            ? {
                ...event,
                failure: {
                  ...event.failure,
                  resetAt:
                    event.failure.resetAt ??
                    codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)),
                },
              }
            : event;
        yield* emitProviderEvent(current);
        const continued = continuedRuns.get(context.providerTurnId) ?? [context];
        if (current.status !== "completed") {
          yield* Ref.update(
            terminalizedNonCompletedNativeTurns,
            (nativeTurns) =>
              new Set([...nativeTurns, ...continued.map((turn) => turn.nativeTurnId)]),
          );
        }
        for (const turn of continued) {
          continuedRuns.delete(turn.providerTurnId);
        }
        const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
        const rootProviderThread =
          nativeThreadId == null ? undefined : rootProviderThreads.get(nativeThreadId);
        if (nativeThreadId != null && rootProviderThread !== undefined) {
          rootProviderThreads.set(nativeThreadId, { ...rootProviderThread, status: "idle" });
        }
        if (current.status === "failed" && current.failure.class === "usage_limit") {
          const item = makeProviderFailureTurnItem({
            driver: CODEX_PROVIDER,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId: context.input.rootNodeId,
            providerThreadId: current.providerThreadId,
            providerTurnId: current.providerTurnId,
            itemOrdinal: current.failureItemOrdinal,
            failure: current.failure,
            occurredAt: yield* DateTime.now,
          });
          yield* Ref.update(limitedTurnItems, (items) =>
            new Map(items).set(context.providerThread.id, item),
          );
        }
      });

const settleGoalHold = Effect.fnUntraced(function* (
        hold: CodexGoalHold,
        status: "completed" | "interrupted",
      ) {
        yield* emitProviderEvent({
          type: "provider_turn.updated",
          driver: CODEX_PROVIDER,
          threadId: hold.context.projectionThreadId,
          providerTurn: hold.completedTurn,
        });
        yield* emitRootTerminal(hold.context, { ...hold.event, status });
        yield* Deferred.succeed(hold.next, undefined);
      });

const releaseGoalHold = Effect.fnUntraced(function* (
        nativeThreadId: string,
        expected?: CodexRootTerminalEvent,
      ) {
        const hold = goalHolds.get(nativeThreadId);
        if (hold === undefined || goalStops.has(nativeThreadId)) return;
        if (expected !== undefined && hold.event !== expected) return;
        goalHolds.delete(nativeThreadId);
        yield* settleGoalHold(hold, "completed");
      });

  return { emitCompactionItem, emitRootTerminal, settleGoalHold, releaseGoalHold };
});

export type EmitRootTerminalPart = ReturnType<typeof installEmitRootTerminal> extends Effect.Effect<infer A, infer _E, infer _R> ? A : ReturnType<typeof installEmitRootTerminal>;
