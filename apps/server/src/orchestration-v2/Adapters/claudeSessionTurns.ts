// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { Deps as PrevDeps } from "./claudeSessionQuery.ts";
import { installQuery } from "./claudeSessionQuery.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_WAKE_TURN_START_DEADLINE } from "./ClaudeProviderIdentity.ts";
import { getNativeThreadId } from "./ClaudeProviderMessages.ts";
import { isClaudePromptUuid } from "./ClaudeUserMessage.ts";
import { isClaudeProviderContinuationTurn } from "./ClaudeApprovals.ts";
import { isClaudeTaskNotificationOriginResult } from "./ClaudeApprovals.ts";
import { isClaudeTurnStartMessage } from "./ClaudeToolClassification.ts";
import { makeClaudeAttachmentBudget } from "./ClaudeUserMessage.ts";
import { makeClaudeUserMessageWithAttachments } from "./ClaudeUserMessage.ts";
import { permissionModeForClaudeRuntimePolicy } from "./ClaudeRuntimePolicy.ts";
import { reserveClaudePdfBudget } from "./ClaudeUserMessage.ts";
import { terminalStatusFromResult } from "./ClaudeApprovals.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";

export type Deps = PrevDeps & ReturnType<typeof installQuery>;

export const installTurns = (s: Deps) => {
  const {
    attachmentsDir,
    fileSystem,
    path,
    random,
    idAllocator,
    spawner,
    announcedBypassDowngrades,
    userInvocableSkills,
    input,
  } = s.env;
  const {
    sessionScope,
    activeTurn,
    sdkMessageLock,
    interruptedTurns,
    queryContext,
    pdfBudgets,
    lastTurnRouteByNativeThread,
    opaqueBackgroundTaskReplayTombstonesByNativeThread,
    goalsByNativeThread,
    wakeBuffers,
    startUserTurnForWakeReports,
    requestedContinuations,
    absorbedWakes,
    emitProviderEvent,
    persistAttachmentBudget,
    rememberProviderThread,
    taskIdSetForNativeThread,
    forgetAbsorbedWake,
    resolveItemOrdinal,
    providerTurnPayload,
    finalizeActiveTurn,
    handleSdkMessage,
    openQuery,
  } = s;
  const startTurn = Effect.fn("ClaudeAdapterV2.startTurn")(
    function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
      const startedAt = yield* DateTime.now;
      const nativeThreadId = yield* getNativeThreadId(turnInput.providerThread);
      const nativeTurnId = `turn:${turnInput.attemptId}`;
      // Use fresh uuids: native sessions can outlive this database, and Claude skips previously recorded prompts.
      const promptUuid = isClaudeProviderContinuationTurn(turnInput)
        ? null
        : yield* random.uuidV4().pipe(
            Effect.filterOrFail(isClaudePromptUuid),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CLAUDE_PROVIDER,
                  detail: "Failed to allocate a Claude prompt uuid.",
                  payload: cause,
                }),
            ),
          );
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: CLAUDE_PROVIDER,
        nativeTurnId,
      });
      const providerTurnOrdinal = turnInput.providerTurnOrdinal;
      const currentTurn = yield* Ref.get(activeTurn);
      if (currentTurn !== null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: CLAUDE_PROVIDER,
          detail: `Claude provider turn ${currentTurn.providerTurnId} is still active.`,
          reason: "previous_turn_active",
        });
      }
      yield* Ref.update(lastTurnRouteByNativeThread, (current) => {
        const updated = new Map(current);
        updated.set(nativeThreadId, {
          threadId: turnInput.threadId,
          providerThreadId: turnInput.providerThread.id,
        });
        return updated;
      });
      yield* rememberProviderThread(turnInput.providerThread);
      if (!goalsByNativeThread.has(nativeThreadId)) {
        goalsByNativeThread.set(nativeThreadId, turnInput.providerThread.goal ?? null);
      }
      if (!pdfBudgets.has(nativeThreadId)) {
        // Older sessions did not record retained attachments. Keep their
        // existing native-image allowance rather than disabling images.
        const used = turnInput.providerThread.nativeMetadata?.claudeAttachmentBudget;
        pdfBudgets.set(nativeThreadId, makeClaudeAttachmentBudget(used));
      }
      const pdfReservation = yield* reserveClaudePdfBudget(
        pdfBudgets.get(nativeThreadId)!,
        persistAttachmentBudget(nativeThreadId),
      );
      const userMessage =
        promptUuid === null
          ? null
          : yield* makeClaudeUserMessageWithAttachments({
              text: applyClaudePromptEffortPrefix(
                turnInput.message.text,
                compileClaudeModelSelection(turnInput.modelSelection).promptEffort,
              ),
              attachments: turnInput.message.attachments,
              attachmentsDir,
              fileSystem,
              pdfReservation,
              skills: yield* userInvocableSkills(turnInput.runtimePolicy.cwd),
              uuid: promptUuid,
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Path.Path, path),
            );
      const querySession = yield* openQuery(turnInput, nativeThreadId);
      const context: ActiveClaudeTurnContext = {
        input: turnInput,
        queryPolicy: querySession.queryPolicy,
        nativeThreadId,
        nativeTurnId,
        nativeMessageCursor: null,
        providerTurnId,
        providerTurnOrdinal,
        startedAt,
        itemOrdinals: new Map(),
        assistant: {
          fallbackText: "",
          fallbackNativeItemId: `assistant:${turnInput.runId}`,
          emittedNativeItemIds: new Set(),
          noticeTexts: new Set(),
        },
        reasoning: {
          messageId: null,
          streamBlocks: new Map(),
          nextBlockIndex: new Map(),
          snapshotBlockIndex: new Map(),
          lastThinking: null,
          snapshots: new Set(),
          blocks: new Map(),
        },
        streamUsage: null,
        compactionTokens: undefined,
        toolCalls: new Map(),
        compaction: null,
        ignoredTaskIds: new Set(),
        announcedUsageLimits: new Set(),
        authenticationFailureMessage: undefined,
        rejectedRateLimitTypes: new Set(),
        rateLimitResetTimes: new Map(),
        latestAssistantRateLimit: null,
        compactionFailure: null,
        steeredSegmentUsage: [],
        steeredLedgerUsage: { inputTokens: 0, outputTokens: 0 },
        rootModels: new Set(),
        subagentsByTaskId: new Map(),
        subagentsByToolUseId: new Map(),
        promptUuid,
        promptEcho: isClaudeProviderContinuationTurn(turnInput) ? "confirmed" : "pending",
        promptStarted: false,
        nativeWakeStarted: false,
        gatedFramesBeforeEcho: 0,
        heldRootFrames: [],
      };
      const attachTurn = Effect.gen(function* () {
        querySession.lastTurn = context;
        yield* Ref.set(activeTurn, context);
        if (
          !isClaudeProviderContinuationTurn(turnInput) &&
          permissionModeForClaudeRuntimePolicy(turnInput.runtimePolicy) === "bypassPermissions" &&
          context.queryPolicy.permissionMode !== "bypassPermissions" &&
          !announcedBypassDowngrades.has(turnInput.threadId)
        ) {
          announcedBypassDowngrades.add(turnInput.threadId);
          if (announcedBypassDowngrades.size > 1000) {
            const oldest = announcedBypassDowngrades.values().next().value;
            if (oldest !== undefined) announcedBypassDowngrades.delete(oldest);
          }
          const nativeItemId = `bypass-policy-downgrade:${context.providerTurnId}`;
          const notice =
            "T3 could not confirm Claude bypass permissions here, so Full access is running with approval checks.";
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId,
              }),
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: nativeItemId,
                strength: "weak",
              },
              parentItemId: null,
              ordinal: yield* resolveItemOrdinal(context, nativeItemId),
              type: "system_notice",
              status: "completed",
              title: notice,
              message: notice,
              startedAt,
              completedAt: startedAt,
              updatedAt: startedAt,
            },
          });
        }
        yield* emitProviderEvent({
          type: "provider_turn.updated",
          driver: CLAUDE_PROVIDER,
          providerTurn: providerTurnPayload({
            context,
            status: "running",
            completedAt: null,
          }),
        });
      });
      if (userMessage !== null) {
        yield* attachTurn;
        yield* startUserTurnForWakeReports(nativeThreadId);
        yield* Effect.uninterruptibleMask((restore) =>
          restore(
            querySession.query.offer(userMessage, () => {
              pdfReservation.commit();
            }),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pdfReservation.commit();
              }),
            ),
          ),
        );
        return;
      }
      // Transcript reads suspend replay; hold SDK frames until the buffer is applied to preserve order.
      yield* sdkMessageLock.withPermits(1)(
        Effect.gen(function* () {
          if (
            (yield* Ref.get(queryContext))?.query !== querySession.query ||
            querySession.stopping
          ) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: "Claude provider query ended before the continuation could start.",
            });
          }
          yield* attachTurn;
          const drained = (yield* Ref.get(wakeBuffers)).get(nativeThreadId)?.messages ?? [];
          yield* Ref.update(requestedContinuations, (current) => {
            const updated = new Set(current);
            updated.delete(nativeThreadId);
            return updated;
          });
          const wakeAbsorbed = (yield* Ref.get(absorbedWakes)).has(nativeThreadId);
          yield* forgetAbsorbedWake(nativeThreadId);
          if (drained.length === 0) {
            const completedAt = yield* DateTime.now;
            yield* finalizeActiveTurn({ context, status: "completed", completedAt });
            return;
          }
          // Replay results last to avoid rebuffering later frames. An empty turn's result must not settle a newer running turn.
          const lastResultIndex = drained.findLastIndex((entry) => entry.type === "result");
          const tailResult = drained[lastResultIndex];
          const emptyTurnBeforeNextTurn =
            tailResult?.type === "result" &&
            tailResult.num_turns === 0 &&
            !tailResult.is_error &&
            terminalStatusFromResult(tailResult) === "completed" &&
            drained.slice(lastResultIndex + 1).some((entry) => isClaudeTurnStartMessage(entry));
          // The CLI can append empty task successes after a failure. Filter
          // those for replay without changing the raw-tail successor guard.
          const isEmptyTaskNotificationSuccess = (entry: SDKMessage) =>
            isClaudeTaskNotificationOriginResult(entry) &&
            entry.subtype === "success" &&
            !entry.is_error &&
            entry.num_turns === 0 &&
            entry.result.length === 0 &&
            terminalStatusFromResult(entry) === "completed";
          const replayResultIndex = drained.findLastIndex(
            (entry) => entry.type === "result" && !isEmptyTaskNotificationSuccess(entry),
          );
          const lastResult =
            drained[replayResultIndex === -1 ? lastResultIndex : replayResultIndex];
          const opaqueReplayTombstones = taskIdSetForNativeThread(
            yield* Ref.get(opaqueBackgroundTaskReplayTombstonesByNativeThread),
            nativeThreadId,
          );
          const hasOpaqueTaskNotification = drained.some(
            (entry) =>
              entry.type === "system" &&
              entry.subtype === "task_notification" &&
              opaqueReplayTombstones.has(entry.task_id),
          );
          for (const entry of drained) {
            if (!(yield* Ref.get(wakeBuffers)).get(nativeThreadId)?.messages.includes(entry)) {
              continue;
            }
            if (entry.type !== "result") {
              yield* handleSdkMessage({ query: querySession.query, message: entry });
            }
            yield* Ref.update(wakeBuffers, (current) => {
              const buffered = current.get(nativeThreadId);
              if (buffered === undefined) return current;
              const index = buffered.messages.indexOf(entry);
              if (index === -1) return current;
              const messages = [
                ...buffered.messages.slice(0, index),
                ...buffered.messages.slice(index + 1),
              ];
              const next = new Map(current);
              if (messages.length === 0) next.delete(nativeThreadId);
              else next.set(nativeThreadId, { ...buffered, messages });
              return next;
            });
          }
          if (lastResult !== undefined && !emptyTurnBeforeNextTurn) {
            yield* handleSdkMessage({ query: querySession.query, message: lastResult });
            return;
          }
          if (wakeAbsorbed || (hasOpaqueTaskNotification && !context.nativeWakeStarted)) {
            const completedAt = yield* DateTime.now;
            yield* finalizeActiveTurn({ context, status: "completed", completedAt });
          } else if (!context.nativeWakeStarted) {
            yield* Effect.sleep(CLAUDE_WAKE_TURN_START_DEADLINE).pipe(
              Effect.andThen(
                sdkMessageLock.withPermits(1)(
                  Effect.gen(function* () {
                    if (
                      (yield* Ref.get(activeTurn)) !== context ||
                      (yield* Ref.get(queryContext)) !== querySession ||
                      querySession.stopping ||
                      context.nativeWakeStarted ||
                      (yield* Ref.get(interruptedTurns)).has(context.providerTurnId)
                    )
                      return;
                    yield* Effect.logWarning("orchestration-v2.claude-wake-turn-never-opened", {
                      providerTurnId: context.providerTurnId,
                      nativeThreadId,
                    });
                    const completedAt = yield* DateTime.now;
                    yield* finalizeActiveTurn({ context, status: "completed", completedAt });
                  }),
                ),
              ),
              Effect.forkIn(sessionScope),
            );
          }
        }),
      );
    },
    (effect, turnInput) =>
      effect.pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: CLAUDE_PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause,
            }),
        ),
      ),
  );

  return {
    startTurn,
  };
};
