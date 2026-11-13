/**
 * Pi session runtime surface: thread lifecycle, turns and runtime requests.
 */
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { parsePiCompactCommand, type PiCompactCommand } from "../commands.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
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
import {
  piUiResponse,
} from "./projection.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";
import type { Tools } from "./tools.ts";
import type { Usage } from "./usage.ts";
import type { Turns } from "./turns.ts";
import type { ExtensionUi } from "./extensionUi.ts";
import type { Events } from "./events.ts";
import type { Threads } from "./threads.ts";

type PiRuntimeCore = Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "instanceId" | "driver" | "providerSessionId" | "providerSession" | "events" | "hasPendingBackgroundWork" | "hasPendingBackgroundWorkForThread" | "getModelContextWindow" | "ensureThread" | "resumeThread" | "compactThread" | "startTurn" | "steerTurn" | "interruptTurn" | "respondToRuntimeRequest" | "readThreadSnapshot">;

export const makeRuntimeCore = (deps: State & Emitters & Tools & Usage & Turns & ExtensionUi & Events & Threads): PiRuntimeCore => {
  const {
    options,
    input,
    connection,
    idAllocator,
    now,
    events,
    sendPrompt,
    compactRpcRecord,
    request,
    pendingPrompts,
    sessionApprovals,
    sessionEventPermit,
    outOfTurnExtensionErrors,
    modelContextWindows,
    pendingCompactResponses,
  } = deps;
  const m = deps.mutable;
  const runtime: PiRuntimeCore = {
    instanceId: options.instanceId,
    driver: PI_PROVIDER,
    providerSessionId: input.providerSessionId,
    get providerSession() {
      return m.sessionEntity;
    },
    events: Stream.fromQueue(events),
    hasPendingBackgroundWork: Effect.sync(() => m.pendingWake !== null),
    hasPendingBackgroundWorkForThread: (providerThread) =>
      Effect.sync(
        () => m.pendingWake !== null && m.pendingWake.state.providerThread.id === providerThread.id,
      ),
    getModelContextWindow: (selection) => {
      if (selection.instanceId !== options.instanceId) return undefined;
      const slug =
        selection.model === PI_INHERIT_MODEL_SLUG
          ? m.baselineModel === null
            ? undefined
            : `${m.baselineModel.provider}/${m.baselineModel.modelId}`
          : selection.model;
      return slug === undefined ? undefined : modelContextWindows.get(slug);
    },
    ensureThread: (threadInput) =>
      deps.registerThread(threadInput).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterEnsureThreadError({
              driver: PI_PROVIDER,
              threadId: threadInput.threadId,
              cause,
            }),
        ),
      ),
    resumeThread: (threadInput) =>
      deps.registerThread({
        threadId:
          threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
        modelSelection: threadInput.modelSelection ?? input.modelSelection,
        runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
        existingProviderThread: threadInput.providerThread,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterResumeThreadError({
              driver: PI_PROVIDER,
              providerSessionId: input.providerSessionId,
              providerThreadId: threadInput.providerThread.id,
              cause,
            }),
        ),
      ),
    compactThread: (turnInput) =>
      runtime.startTurn({
        ...turnInput,
        message: { ...turnInput.message, text: "/compact" },
      }),
    startTurn: Effect.fn("PiAdapter.startTurn")(
      function* (turnInput) {
        if (m.rollbackBarrier !== null)
          return yield* protocolError("Cannot start a Pi turn during rollback");
        const state = m.threadState;
        if (state === null) {
          return yield* protocolError("Pi session has no registered thread");
        }
        if (state.activeTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: PI_PROVIDER,
            detail: `Pi provider thread ${turnInput.providerThread.id} already has an active turn`,
            reason: "previous_turn_active",
          });
        }
        if (
          state.providerThread.nativeThreadRef?.nativeId !==
          turnInput.providerThread.nativeThreadRef?.nativeId
        ) {
          return yield* protocolError("Pi turn requested for a different native session");
        }
        // Fork adoption uses the orchestrator-allocated row; preserve that identity in later updates.
        const continuation =
          turnInput.message.createdBy === "agent" &&
          turnInput.message.creationSource === "provider";
        if (!continuation) yield* deps.applySelection(turnInput.modelSelection);
        if (turnInput.appThread.title !== m.appliedSessionName) {
          yield* request({
            type: "set_session_name",
            name: turnInput.appThread.title,
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => (m.appliedSessionName = turnInput.appThread.title)),
            ),
            Effect.ignore,
          );
        }
        // Resolve attachments before turn installation so failures cannot strand activeTurn.
        // Inject instructions through before_agent_start; wrapping user text breaks slash-command expansion.
        const compactCommand = continuation
          ? null
          : parsePiCompactCommand(turnInput.message.text);
        const payload =
          !continuation && compactCommand === null
            ? yield* deps.resolvePromptPayload(turnInput.message.text, turnInput.message.attachments)
            : null;
        const startedAt = yield* DateTime.now;
        const syntheticNativeTurnId = `${state.providerThread.id}:attempt:${turnInput.attemptId}`;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: PI_PROVIDER,
            nativeTurnId: syntheticNativeTurnId,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const activeTurn: ActivePiTurn = {
          turnInput,
          providerTurn,
          startedAt,
          itemOrdinals: new Map(),
          nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          messageOrdinal: 0,
          streamItems: new Map(),
          toolArgs: new Map(),
          toolStartedAt: new Map(),
          interrupted: false,
          nativeAborted: false,
          sawAgentActivity: false,
          adoptedWake: false,
          promptMayBeCommandOnly:
            compactCommand !== null || (payload?.message.trimStart().startsWith("/") ?? false),
          latestCompactionAfterTokens: null,
          lastLiveUsedTokens: null,
          settleProbeGeneration: 0,
          settleWhenIdle: false,
          sawCompaction: false,
          manualCompactInFlight: compactCommand !== null,
          activeCompaction: null,
          activeProviderRetry: null,
          failure: null,
          rejectedPromptFailure: null,
        };
        // Lock only install/send/start events; correlated setup must leave the pump free for dialogs.
        yield* Effect.gen(function* () {
          if (
            m.threadState !== state ||
            state.activeTurn !== null ||
            m.closed ||
            m.stopRequested ||
            m.rollbackBarrier !== null ||
            state.providerThread.nativeThreadRef?.nativeId !==
              turnInput.providerThread.nativeThreadRef?.nativeId
          ) {
            return yield* protocolError("Pi turn ownership changed before it could start");
          }
          const wake = m.pendingWake?.state === state ? m.pendingWake : null;
          if (wake !== null && wake.state.providerThread.appThreadId !== turnInput.threadId) {
            return yield* protocolError("Pi native wake belongs to a different app thread");
          }
          m.pendingWake = null;
          state.providerThread = turnInput.providerThread;
          state.activeTurn = activeTurn;
          activeTurn.adoptedWake = wake !== null && !continuation;
          if (compactCommand !== null) {
            yield* connection.send(compactRpcRecord(compactCommand));
            pendingCompactResponses.push({
              providerTurnId: providerTurn.id,
              kind: "turn_start",
            });
          } else if (payload !== null) {
            yield* sendPrompt({
              providerTurnId: providerTurn.id,
              kind: "turn_start",
              record: {
                type: "prompt",
                message: payload.message,
                streamingBehavior: "steer",
                ...(payload.images.length === 0 ? {} : { images: payload.images }),
              },
            });
          }
          yield* deps.emit({
            type: "provider_turn.updated",
            driver: PI_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* deps.updateProviderThread(state, {
            status: "active",
            firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* deps.updateProviderSession("running", null);
          if (wake !== null) {
            for (const event of wake.events) {
              if (!continuation && event["type"] === "agent_settled") {
                activeTurn.nativeAborted = event["aborted"] === true;
                activeTurn.settleWhenIdle = true;
                continue;
              }
              yield* deps.handleSessionEvent(event);
            }
          } else if (continuation) {
            yield* deps.finalizeTurn(state);
          }
          if (outOfTurnExtensionErrors.length > 0) {
            yield* Queue.offer(connection.events, { type: "t3.flush_extension_errors" });
          }
        }).pipe(
          sessionEventPermit.withPermits(1),
          Effect.tapError(() =>
            Effect.sync(() => {
              if (state.activeTurn === activeTurn) state.activeTurn = null;
            }),
          ),
        );
        // Pi acks `prompt` only after slash-command expansion completes,
        // and extension commands may block on user dialogs indefinitely.
        // Rejections therefore return later as id-less response records
        // handled by the event pump.
      },
      (effect, turnInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: PI_PROVIDER,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause,
              }),
          ),
        ),
    ),
    steerTurn: Effect.fn("PiAdapter.steerTurn")(
      function* (steerInput: ProviderAdapter.ProviderAdapterV2SteerInput) {
        const turn = m.threadState?.activeTurn ?? null;
        if (turn === null || turn.providerTurn.id !== steerInput.providerTurnId) {
          return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
        }
        const compactCommand = parsePiCompactCommand(steerInput.message.text);
        const payload =
          compactCommand === null
            ? yield* deps.resolvePromptPayload(
                steerInput.message.text,
                steerInput.message.attachments,
              )
            : null;
        // prompt with steer atomically queues or starts; fire-and-forget under the permit avoids dialog deadlocks.
        // /compact uses its RPC, which aborts the agent first.
        yield* sessionEventPermit.withPermits(1)(
          Effect.gen(function* () {
            if (m.threadState?.activeTurn !== turn) {
              return yield* protocolError(`Pi turn ${steerInput.providerTurnId} is not active`);
            }
            if (compactCommand !== null) {
              turn.manualCompactInFlight = true;
              yield* connection.send(compactRpcRecord(compactCommand));
              pendingCompactResponses.push({
                providerTurnId: turn.providerTurn.id,
                kind: "steer",
              });
            } else if (payload !== null) {
              yield* sendPrompt({
                providerTurnId: turn.providerTurn.id,
                kind: "steer",
                record: {
                  type: "prompt",
                  message: payload.message,
                  streamingBehavior: "steer",
                  ...(payload.images.length === 0 ? {} : { images: payload.images }),
                },
              });
            }
            turn.settleProbeGeneration += 1;
          }),
        );
      },
      (effect, steerInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterSteerRunError({
                driver: PI_PROVIDER,
                providerThreadId: steerInput.providerThread.id,
                providerTurnId: steerInput.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    interruptTurn: Effect.fn("PiAdapter.interruptTurn")(
      function* (interruptInput) {
        const turn = m.threadState?.activeTurn ?? null;
        if (turn === null && interruptInput.requestRuntimeRestart === true) {
          if (m.pendingWake !== null)
            yield* sessionEventPermit.withPermits(1)(deps.stopPendingWake(m.pendingWake));
          return;
        }
        if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
          return yield* protocolError(`Pi turn ${interruptInput.providerTurnId} is not active`);
        }
        turn.interrupted = true;
        if (
          interruptInput.requestRuntimeRestart === true ||
          turn.settleWhenIdle ||
          turn.activeCompaction !== null ||
          turn.manualCompactInFlight ||
          m.nativeCompacting
        ) {
          // Generic abort misses manual compaction; terminate so Stop covers /compact and recovery.
          m.stopRequested = true;
          if (interruptInput.requestRuntimeRestart === true && !turn.settleWhenIdle) {
            yield* deps.clearNativeQueue(turn);
            yield* request({ type: "abort" }, 2_000).pipe(Effect.ignore);
          }
          // Read rollback tree refs before termination breaks requests; the permit lets in-flight capture finish.
          yield* sessionEventPermit.withPermits(1)(
            Effect.gen(function* () {
              if (m.threadState?.activeTurn === turn && turn.stopTreeRefs === undefined) {
                turn.stopTreeRefs = yield* deps.captureTurnTreeRefs(2_000);
              }
              yield* connection.terminate;
            }),
          );
          return;
        }
        yield* deps.clearNativeQueue(turn);
        yield* request({ type: "abort" }).pipe(
          Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
        );
      },
      (effect, interruptInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver: PI_PROVIDER,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    respondToRuntimeRequest: Effect.fn("PiAdapter.respondToRuntimeRequest")(
      function* (requestInput) {
        const pending = pendingPrompts.get(String(requestInput.requestId));
        if (pending === undefined) {
          return yield* protocolError(
            `No pending Pi extension request ${requestInput.requestId}`,
          );
        }
        const answeredAt = yield* DateTime.now;
        if (
          pending.expiresAt !== null &&
          DateTime.toEpochMillis(answeredAt) >= pending.expiresAt
        ) {
          pendingPrompts.delete(String(requestInput.requestId));
          yield* deps.cancelPrompt(pending, answeredAt);
          return yield* protocolError(
            `Pi extension request ${requestInput.requestId} has expired`,
          );
        }
        const response = piUiResponse(pending, requestInput.decision, requestInput.answers);
        yield* connection.send({
          type: "extension_ui_response",
          id: pending.nativeRequestId,
          ...response,
        });
        pendingPrompts.delete(String(requestInput.requestId));
        if (pending.expirationFiber !== null) yield* Fiber.interrupt(pending.expirationFiber);
        if (pending.method === "confirm" && requestInput.decision === "acceptForSession") {
          sessionApprovals.add(pending.approvalKey);
        }
        const resolvedAt = yield* DateTime.now;
        pending.runtimeRequest = {
          ...pending.runtimeRequest,
          status: "resolved",
          resolvedAt,
        };
        yield* deps.emit({
          type: "runtime_request.updated",
          driver: PI_PROVIDER,
          threadId: pending.node.threadId,
          runtimeRequest: pending.runtimeRequest,
        });
        yield* deps.emit({
          type: "node.updated",
          driver: PI_PROVIDER,
          node: { ...pending.node, status: "completed", completedAt: resolvedAt },
        });
        yield* deps.emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...pending.turnItem,
            status: "completed",
            completedAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
      },
      (effect, requestInput) =>
        effect.pipe(
          sessionEventPermit.withPermits(1),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: PI_PROVIDER,
                requestId: requestInput.requestId,
                cause,
              }),
          ),
        ),
    ),
    readThreadSnapshot: Effect.fn("PiAdapter.readThreadSnapshot")(
      function* (snapshotInput) {
        const state = m.threadState;
        const boundNativeId = state?.providerThread.nativeThreadRef?.nativeId;
        const wantedNativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
        if (state === null || wantedNativeId == null || boundNativeId !== wantedNativeId) {
          return yield* protocolError(
            "Pi snapshot requested for a thread this session does not host",
          );
        }
        // get_messages contains only the active branch; get_entries would leak abandoned branches into handoffs.
        const messagesData = yield* request({ type: "get_messages" });
        const activeMessages = recordField(messagesData, "messages");
        const threadId = state.providerThread.appThreadId ?? input.threadId;
        const messages = (Array.isArray(activeMessages) ? activeMessages : []).flatMap(
          (message, index) => {
            const role = recordString(message, "role");
            if (role !== "user" && role !== "assistant") return [];
            const text = contentText(recordField(message, "content"));
            if (text.length === 0) return [];
            const timestamp = recordNumber(message, "timestamp");
            const at = Option.getOrElse(
              DateTime.make(timestamp ?? Number.NaN),
              () => state.providerThread.createdAt,
            );
            return [
              {
                id: idAllocator.derive.messageFromProviderItem({
                  driver: PI_PROVIDER,
                  nativeItemId: `${wantedNativeId}:snapshot-message:${index}`,
                }),
                threadId,
                runId: null,
                nodeId: null,
                role: role as "user" | "assistant",
                text,
                attachments: [],
                streaming: false,
                createdBy: role === "user" ? ("user" as const) : ("agent" as const),
                creationSource: "provider" as const,
                createdAt: at,
                updatedAt: at,
              },
            ];
          },
        );
        return {
          providerThread: state.providerThread,
          providerTurns: [],
          messages,
          runtimeRequests: [],
        };
      },
      (effect, snapshotInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: PI_PROVIDER,
                providerThreadId: snapshotInput.providerThread.id,
                cause,
              }),
          ),
        ),
    ),
  };
  return runtime;
};
