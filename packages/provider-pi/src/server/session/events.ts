/**
 * Pi RPC session event pump: the single stream of native events projected into T3 items.
 */
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";
import type { Tools } from "./tools.ts";
import type { Usage } from "./usage.ts";
import type { Turns } from "./turns.ts";
import type { ExtensionUi } from "./extensionUi.ts";

export const makeEvents = (deps: State & Emitters & Tools & Usage & Turns & ExtensionUi) => {
  const {
    input,
    connection,
    continuationRequests,
    now,
    events,
    scope,
    sendPrompt,
    pendingPrompts,
    sessionEventPermit,
    outOfTurnExtensionErrors,
    pendingPromptResponses,
    pendingCompactResponses,
    heldPrompts,
  } = deps;
  const m = deps.mutable;
  const handleSessionEvent = Effect.fnUntraced(function* (event: PiRpcRecord) {
    // Model hooks can show dialogs before turn ownership; keep requests session-scoped and buffer output.
    const interactiveUiRequest =
      event["type"] === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(String(event["method"]));
    if (
      m.threadState?.activeTurn === null &&
      m.pendingWake !== null &&
      !interactiveUiRequest &&
      !String(event["type"]).startsWith("t3.") &&
      event["type"] !== "response"
    ) {
      m.pendingWake.events.push(event);
      if (event["type"] === "agent_start") yield* deps.updateProviderSession("running", null);
      if (event["type"] === "agent_settled") yield* deps.updateProviderSession("ready", null);
      return;
    }
    const state = m.threadState;
    const turn = state?.activeTurn ?? null;
    switch (event["type"]) {
      case "agent_start": {
        if (
          turn === null &&
          state?.providerThread.appThreadId != null &&
          continuationRequests !== undefined &&
          !m.closed &&
          !m.stopRequested
        ) {
          const wake: PiWake = { state, events: [event] };
          m.pendingWake = wake;
          if (m.rollbackBarrier !== null) {
            yield* deps.stopPendingWake(wake);
            return;
          }
          yield* deps.updateProviderSession("running", null);
          yield* continuationRequests
            .offer({
              threadId: state.providerThread.appThreadId,
              providerThreadId: state.providerThread.id,
              driver: PI_PROVIDER,
              detail: null,
              delivery: "adapter_buffered",
              dispatchIfCurrent: (dispatch) =>
                sessionEventPermit.withPermits(1)(
                  Effect.suspend(() =>
                    m.pendingWake === wake && m.threadState === state && !m.closed
                      ? dispatch.pipe(
                          Effect.asSome,
                          Effect.tapError(() => deps.stopPendingWake(wake)),
                        )
                      : Effect.succeedNone,
                  ),
                ),
              clearIfCurrent: () => sessionEventPermit.withPermits(1)(deps.stopPendingWake(wake)),
            })
            .pipe(Effect.tapError(() => deps.stopPendingWake(wake)));
          return;
        }
        if (turn === null) {
          m.unsolicitedActivityDetected = true;
          yield* deps.updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
          yield* connection.terminate;
          return;
        }
        turn.sawAgentActivity = true;
        turn.nativeAborted = false;
        turn.settleProbeGeneration += 1;
        return;
      }
      case "message_start": {
        if (turn !== null && recordString(event["message"], "role") === "assistant") {
          turn.sawAgentActivity = true;
          turn.messageOrdinal += 1;
        }
        return;
      }
      case "message_update": {
        if (turn === null) return;
        turn.sawAgentActivity = true;
        yield* deps.reportLiveUsage(turn, event["usage"]);
        const delta = event["assistantMessageEvent"];
        const deltaType = recordString(delta, "type");
        const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
        if (deltaType === "text_delta" || deltaType === "thinking_delta") {
          const item = yield* deps.streamItemFor(
            turn,
            deltaType === "text_delta" ? "assistant_message" : "reasoning",
            contentIndex,
          );
          item.text += recordString(delta, "delta") ?? "";
          yield* deps.scheduleStreamFlush(turn, item);
          return;
        }
        if (deltaType === "text_end" || deltaType === "thinking_end") {
          const item = yield* deps.streamItemFor(
            turn,
            deltaType === "text_end" ? "assistant_message" : "reasoning",
            contentIndex,
          );
          yield* deps.completeStreamItem(
            turn,
            item,
            recordString(delta, "content") ?? recordString(delta, "thinking"),
          );
          return;
        }
        return;
      }
      case "message_end": {
        if (turn === null) return;
        const message = event["message"];
        if (recordString(message, "role") !== "assistant") return;
        yield* deps.completeOpenStreamItems(turn);
        if (recordString(message, "stopReason") === "error" && turn.failure === null) {
          turn.failure = makeProviderFailure({
            message: recordString(message, "errorMessage") ?? "Pi reported a model error.",
            class: "provider_error",
          });
        }
        return;
      }
      case "tool_execution_start":
        if (turn !== null) {
          turn.sawAgentActivity = true;
          yield* deps.emitToolItem(turn, event, "start");
        }
        return;
      case "tool_execution_update":
        if (turn !== null) yield* deps.emitToolItem(turn, event, "update");
        return;
      case "tool_execution_end":
        if (turn !== null) yield* deps.emitToolItem(turn, event, "end");
        return;
      case "compaction_start": {
        if (turn === null) return;
        turn.settleProbeGeneration += 1;
        turn.sawCompaction = true;
        if (turn.activeCompaction !== null) {
          yield* deps.emitCompaction(turn, turn.activeCompaction, "cancelled");
        }
        const startedAt = yield* DateTime.now;
        const compaction = {
          nativeItemId: deps.compactionNativeItemId(turn),
          startedAt,
        } satisfies PiCompactionState;
        turn.activeCompaction = compaction;
        yield* deps.emitCompaction(turn, compaction, "running");
        return;
      }
      case "compaction_end": {
        if (turn === null) return;
        const observedAt = yield* DateTime.now;
        const compaction = turn.activeCompaction ?? {
          nativeItemId: deps.compactionNativeItemId(turn),
          startedAt: observedAt,
        };
        turn.activeCompaction = null;
        const result = event["result"];
        if (result === null || result === undefined) {
          if (event["aborted"] === true) {
            yield* deps.emitCompaction(turn, compaction, "cancelled");
            if (
              (turn.settleWhenIdle || !turn.sawAgentActivity) &&
              m.releasedPromptTurnId !== turn.providerTurn.id
            ) {
              yield* deps.scheduleSettleProbe(turn, turn.settleWhenIdle);
            }
            return;
          }
          const errorMessage =
            recordString(event, "errorMessage") ?? "Pi context compaction failed.";
          yield* deps.emitCompaction(turn, compaction, "failed", {
            summary: errorMessage.slice(0, 1_000),
          });
          if (
            (turn.settleWhenIdle || !turn.sawAgentActivity) &&
            m.releasedPromptTurnId !== turn.providerTurn.id
          ) {
            yield* deps.scheduleSettleProbe(turn, turn.settleWhenIdle);
          }
          return;
        }
        // Clear overflow failures only when compaction will retry; ordinary compaction must retain exhausted retries.
        if (event["willRetry"] === true) turn.failure = null;
        turn.latestCompactionAfterTokens =
          deps.nonNegativeInteger(result, "estimatedTokensAfter") ?? null;
        const summary = recordString(result, "summary");
        const beforeTokenCount = deps.nonNegativeInteger(result, "tokensBefore");
        const afterTokenCount = deps.nonNegativeInteger(result, "estimatedTokensAfter");
        yield* deps.emitCompaction(turn, compaction, "completed", {
          ...(summary === undefined ? {} : { summary }),
          ...(beforeTokenCount === undefined ? {} : { beforeTokenCount }),
          ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
        });
        if (
          (turn.settleWhenIdle || !turn.sawAgentActivity) &&
          m.releasedPromptTurnId !== turn.providerTurn.id
        ) {
          yield* deps.scheduleSettleProbe(turn, turn.settleWhenIdle);
        }
        return;
      }
      case "auto_retry_start": {
        if (turn === null) return;
        const emittedAt = yield* DateTime.now;
        const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
        const maxAttempts = Math.max(
          attempt,
          Math.trunc(recordNumber(event, "maxAttempts") ?? attempt),
        );
        const retryDelayMs = Math.max(0, Math.trunc(recordNumber(event, "delayMs") ?? 0));
        const failure = makeProviderFailure({
          message: recordString(event, "errorMessage") ?? "Pi provider request failed.",
          class: "provider_error",
          retryable: true,
        });
        const current = turn.activeProviderRetry;
        const providerRetry = {
          retry: { attempt, maxAttempts, retryDelayMs },
          failure,
          startedAt: current?.startedAt ?? emittedAt,
          itemOrdinal:
            current?.itemOrdinal ??
            deps.itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
        } satisfies PiProviderRetryState;
        turn.activeProviderRetry = providerRetry;
        yield* deps.emitProviderRetry(turn, providerRetry, "running", emittedAt);
        return;
      }
      case "auto_retry_end": {
        if (turn === null) return;
        const emittedAt = yield* DateTime.now;
        if (event["success"] === true) {
          // Successful retries supersede the failure agent_settled would reuse.
          if (turn.activeProviderRetry !== null) {
            const attempt = Math.max(
              1,
              Math.trunc(
                recordNumber(event, "attempt") ?? turn.activeProviderRetry.retry.attempt,
              ),
            );
            const recoveredRetry = {
              ...turn.activeProviderRetry,
              retry: { ...turn.activeProviderRetry.retry, attempt },
            };
            yield* deps.emitProviderRetry(turn, recoveredRetry, "completed", emittedAt);
            turn.activeProviderRetry = null;
          }
          turn.failure = null;
          return;
        }
        const failure = makeProviderFailure({
          message: recordString(event, "finalError") ?? "Pi auto-retry failed.",
          class: "provider_error",
          retryable: false,
        });
        const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
        const current = turn.activeProviderRetry;
        const providerRetry = {
          retry: {
            attempt,
            maxAttempts: current?.retry.maxAttempts ?? attempt,
            retryDelayMs: current?.retry.retryDelayMs ?? null,
          },
          failure,
          startedAt: current?.startedAt ?? emittedAt,
          itemOrdinal:
            current?.itemOrdinal ??
            deps.itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`),
        } satisfies PiProviderRetryState;
        turn.activeProviderRetry = providerRetry;
        turn.failure = failure;
        yield* deps.emitProviderRetry(turn, providerRetry, "failed", emittedAt);
        return;
      }
      case "extension_ui_request":
        yield* deps.handleExtensionUiRequest(event);
        return;
      case "extension_error": {
        yield* deps.emitExtensionError(event);
        return;
      }
      case "agent_settled": {
        if (turn?.interrupted === true) {
          if (state !== null) yield* deps.finalizeTurn(state);
          return;
        }
        if (turn !== null) {
          turn.nativeAborted = event["aborted"] === true;
          turn.settleWhenIdle = true;
          turn.settleProbeGeneration += 1;
          if (
            turn.adoptedWake &&
            pendingPromptResponses.some(
              (pending) =>
                pending.providerTurnId === turn.providerTurn.id &&
                pending.kind === "turn_start",
            )
          )
            return;
          yield* deps.scheduleSettleProbe(turn, true);
        }
        return;
      }
      case "response": {
        const command = recordString(event, "command");
        if (command === "compact") {
          const pendingCompact = pendingCompactResponses.shift();
          const compactTurn =
            pendingCompact?.providerTurnId === turn?.providerTurn.id ? turn : null;
          if (compactTurn !== null) compactTurn.manualCompactInFlight = false;
          if (event["success"] === true) {
            if (
              pendingCompact?.kind === "turn_start" &&
              compactTurn !== null &&
              compactTurn.promptMayBeCommandOnly &&
              !compactTurn.sawAgentActivity
            ) {
              yield* deps.scheduleSettleProbe(compactTurn);
            }
            return;
          }
          if (event["success"] !== false) return;
          if (compactTurn === null) return;
          if (compactTurn.activeCompaction !== null) return;
          if (pendingCompact?.kind === "steer") {
            yield* Effect.logWarning("Pi rejected a compact steer.", {
              errorLength: recordString(event, "error")?.length,
            });
            return;
          }
          if (!compactTurn.sawCompaction) {
            compactTurn.failure = makeProviderFailure({
              message: recordString(event, "error") ?? "Pi compact failed.",
              class: "provider_error",
            });
            if (state !== null) yield* deps.finalizeTurn(state);
            return;
          }
          if (!compactTurn.sawAgentActivity) {
            yield* deps.scheduleSettleProbe(compactTurn);
          }
          return;
        }
        const pendingPrompt = command === "prompt" ? pendingPromptResponses.shift() : undefined;
        const responseTurn =
          pendingPrompt?.providerTurnId === turn?.providerTurn.id ? turn : null;
        if (
          event["success"] === false &&
          m.nativeCompacting &&
          recordString(event, "error")?.startsWith(PI_COMPACTING_PROMPT_REJECTION) === true &&
          pendingPrompt !== undefined &&
          responseTurn !== null
        ) {
          heldPrompts.splice(m.rejectedHeldCount++, 0, pendingPrompt);
          return;
        }
        // Settlement is not probed while a steer awaits its ack (see
        // compaction_end); once Pi answers, the run it may have started is
        // visible to get_state.
        if (pendingPrompt?.kind === "steer" && responseTurn?.settleWhenIdle === true) {
          yield* deps.scheduleSettleProbe(responseTurn, true);
        }
        if (event["success"] === true) {
          // Command-only prompts emit no agent_settled; probe idle and re-queue behind preceding native events.
          if (
            pendingPrompt?.kind === "turn_start" &&
            responseTurn !== null &&
            ((responseTurn.promptMayBeCommandOnly && !responseTurn.sawAgentActivity) ||
              (responseTurn.adoptedWake &&
                (responseTurn.settleWhenIdle || responseTurn.promptMayBeCommandOnly)))
          ) {
            yield* deps.scheduleSettleProbe(responseTurn, responseTurn.adoptedWake);
          }
          return;
        }
        if (event["success"] !== false) return;
        if (command === "steer" || pendingPrompt?.kind === "steer") {
          // A rejected steer refuses only that message; its target turn keeps running.
          yield* Effect.logWarning("Pi rejected a steer message.", {
            errorLength: recordString(event, "error")?.length,
          });
          return;
        }
        const failedTurn =
          command === "prompt" && pendingPrompt?.kind === "turn_start"
            ? responseTurn
            : command === "parse"
              ? turn
              : null;
        if (failedTurn !== null) {
          const failure = makeProviderFailure({
            message: recordString(event, "error") ?? "Pi rejected the prompt.",
            class: "provider_error",
          });
          if (failedTurn.adoptedWake && command === "prompt") {
            failedTurn.rejectedPromptFailure = failure;
            failedTurn.settleWhenIdle = true;
            yield* deps.scheduleSettleProbe(failedTurn, true);
          } else {
            failedTurn.failure = failure;
            if (state !== null) yield* deps.finalizeTurn(state);
          }
        }
        return;
      }
      case "t3.ui_request_expired": {
        const requestId = recordString(event, "requestId");
        if (requestId === undefined) return;
        const pending = pendingPrompts.get(requestId);
        if (pending === undefined || pending !== event["pending"]) return;
        pendingPrompts.delete(requestId);
        yield* deps.cancelPrompt(pending, yield* DateTime.now);
        return;
      }
      case "t3.flush_extension_errors": {
        for (const extensionError of outOfTurnExtensionErrors.splice(0)) {
          yield* deps.emitExtensionError(extensionError);
        }
        return;
      }
      case "t3.rollback_barrier": {
        if (m.rollbackBarrier !== null && event["barrier"] === m.rollbackBarrier)
          yield* Deferred.succeed(m.rollbackBarrier, undefined);
        return;
      }
      case "t3.settle_probe": {
        const data = event["data"];
        const probeFailed = event["probeFailed"] === true;
        const settleAfterAgentActivity = event["settleAfterAgentActivity"] === true;
        const attempt = Math.max(1, Math.trunc(recordNumber(event, "attempt") ?? 1));
        if (
          turn === null ||
          turn.providerTurn.id !== event["providerTurnId"] ||
          turn.settleProbeGeneration !== event["settleProbeGeneration"] ||
          (!settleAfterAgentActivity && turn.sawAgentActivity) ||
          turn.activeCompaction !== null
        ) {
          return;
        }
        if (probeFailed) {
          if (!settleAfterAgentActivity) {
            if (state !== null) yield* deps.finalizeTurn(state);
            return;
          }
          if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
            yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY).pipe(
              Effect.andThen(deps.scheduleSettleProbe(turn, true, attempt + 1)),
              Effect.forkIn(scope),
            );
            return;
          }
          m.stopRequested = true;
          yield* connection.terminate;
          return;
        }
        if (
          recordField(data, "isStreaming") !== true &&
          recordField(data, "isCompacting") !== true &&
          (recordNumber(data, "pendingMessageCount") ?? 0) === 0
        ) {
          turn.settleWhenIdle = false;
          if (state !== null) yield* deps.finalizeTurn(state);
        }
        return;
      }
      default:
        return;
    }
  });

  const startSessionEventPump = Effect.fnUntraced(function* () {
yield* Effect.gen(function* () {
  while (true) {
    const event = yield* Queue.take(connection.events);
    yield* sessionEventPermit.withPermits(1)(
      Effect.gen(function* () {
        // Tracked here rather than in handleSessionEvent, which also
        // replays buffered wake events after they were observed.
        if (event["type"] === "compaction_start") m.nativeCompacting = true;
        if (event["type"] === "compaction_end") {
          m.nativeCompacting = false;
          // Send before the handler can probe settlement, so Pi sees the
          // prompt first. Prompts whose turn ended or is stopping are dropped.
          m.rejectedHeldCount = 0;
          for (const held of heldPrompts.splice(0)) {
            const turn = m.threadState?.activeTurn;
            if (
              turn?.providerTurn.id !== held.providerTurnId ||
              turn.interrupted ||
              m.stopRequested
            )
              continue;
            yield* sendPrompt(held);
            m.releasedPromptTurnId = held.providerTurnId;
          }
        }
        yield* handleSessionEvent(event).pipe(
          Effect.ensuring(Effect.sync(() => (m.releasedPromptTurnId = null))),
        );
      }),
    );
  }
}).pipe(
  Effect.catchCause((cause) =>
    sessionEventPermit.withPermits(1)(
      Effect.gen(function* () {
        const state = m.threadState;
        if (m.rollbackBarrier !== null)
          yield* Deferred.fail(
            m.rollbackBarrier,
            protocolError("Pi transport closed during rollback"),
          );
        m.pendingWake = null;
        const interrupted = state?.activeTurn?.interrupted === true;
        if (state?.activeTurn != null) {
          state.activeTurn.failure = interrupted
            ? null
            : makeProviderFailure({
                cause,
                message: "Pi process exited unexpectedly.",
                class: "transport_error",
              });
          yield* deps.finalizeTurn(state, false);
        } else {
          yield* deps.cancelPendingPrompts(yield* DateTime.now);
        }
        if (m.unsolicitedActivityDetected) {
          yield* deps.updateProviderSession("error", PI_UNSOLICITED_ACTIVITY_ERROR);
          yield* Queue.end(events);
        } else if (m.stopRequested) {
          yield* deps.updateProviderSession("stopped", null);
          yield* Queue.end(events);
        } else {
          yield* deps.updateProviderSession(
            "error",
            interrupted ? "Pi process was stopped." : "Pi process exited unexpectedly.",
          );
          yield* Queue.fail(
            events,
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver: PI_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
          );
        }
      }),
    ),
  ),
  Effect.forkIn(scope),
);
  });

  return { handleSessionEvent, startSessionEventPump };
};

export type Events = ReturnType<typeof makeEvents>;
