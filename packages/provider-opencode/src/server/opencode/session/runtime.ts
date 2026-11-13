/**
 * OpenCode session runtime surface: thread lifecycle, turns and runtime requests.
 */
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
} from "../admission.ts";
import {
  openCodePermissionRules,
} from "../permissions.ts";
import {
  makeProviderThread,
  providerRef,
  unwrapData,
} from "../projection.ts";
import {
  dateTimeFromEpoch,
  nativeThreadId,
  protocolError,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
  makeOpenCodeMessageId,
} from "../provider.ts";
import type {
  ActiveOpenCodeTurn,
} from "../types.ts";
import {
  makeOpenCodeTurnTokenUsageAccumulator,
} from "../usage.ts";
import type { Items } from "./items.ts";
import type { Turns } from "./turns.ts";
import type { Events } from "./events.ts";
import type { Threads } from "./threads.ts";
import type { State } from "./base.ts";

type OpenCodeRuntimeSession = Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "instanceId" | "driver" | "providerSessionId" | "providerSession" | "events" | "hasPendingBackgroundWork" | "ensureThread" | "resumeThread" | "compactThread" | "startTurn" | "steerTurn" | "interruptTurn" | "respondToRuntimeRequest" | "readThreadSnapshot">;

export const makeRuntimeCore = (deps: State & Items & Turns & Events & Threads): OpenCodeRuntimeSession => {
  const {
    options,
    input,
    client,
    idAllocator,
    host,
    messageIdClock,
    now,
    events,
    threads,
    commandControllers,
    pendingRequests,
    busySessionIds,
    sdkCall,
    abortDescendants,
  } = deps;
  const m = deps.mutable;
  const runtimeSession: OpenCodeRuntimeSession = {
    instanceId: options.instanceId,
    driver: OPENCODE_PROVIDER,
    providerSessionId: input.providerSessionId,
    providerSession: m.sessionEntity,
    events: Stream.fromEffectRepeat(Queue.take(events)),
    hasPendingBackgroundWork: Effect.sync(() => busySessionIds.size > 0),
    ensureThread: Effect.fn("OpencodeAdapter.ensureThread")(
      function* (threadInput) {
        if (threadInput.existingProviderThread?.nativeThreadRef != null) {
          return yield* runtimeSession.resumeThread({
            providerThread: threadInput.existingProviderThread,
          });
        }
        const permission = openCodePermissionRules(threadInput.runtimePolicy);
        // OpenCode generates a title only when session.create leaves it unset.
        const response = yield* sdkCall("session.create", { permission }, () =>
          client.session.create({ permission }),
        );
        const nativeSession = unwrapData("session.create", response);
        const createdAt = yield* DateTime.now;
        const created = makeProviderThread({
          idAllocator,
          providerInstanceId: options.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: threadInput.threadId,
          nativeSession,
          now: createdAt,
        });
        const existing = threadInput.existingProviderThread;
        const providerThread =
          existing === undefined
            ? created
            : {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: created.nativeThreadRef,
                nativeConversationHeadRef: created.nativeConversationHeadRef,
                status: created.status,
                updatedAt: created.updatedAt,
              };
        deps.registerThread(nativeSession, providerThread, null).permission = permission;
        return providerThread;
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: OPENCODE_PROVIDER,
                threadId: threadInput.threadId,
                cause,
              }),
          ),
        ),
    ),
    resumeThread: Effect.fn("OpencodeAdapter.resumeThread")(
      function* (threadInput) {
        const sessionId = nativeThreadId(threadInput.providerThread);
        const response = yield* sdkCall("session.get", { sessionID: sessionId }, () =>
          client.session.get({ sessionID: sessionId }),
        );
        const nativeSession = unwrapData("session.get", response);
        const resumedAt = yield* DateTime.now;
        const providerThread = {
          ...threadInput.providerThread,
          providerSessionId: input.providerSessionId,
          status: "idle" as const,
          updatedAt: dateTimeFromEpoch(nativeSession.time.updated, resumedAt),
        };
        const state = deps.registerThread(nativeSession, providerThread, null);
        if (threadInput.runtimePolicy !== undefined) {
          yield* deps.applyPermissionRules(state, threadInput.runtimePolicy);
        }
        return providerThread;
      },
      (effect, threadInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: OPENCODE_PROVIDER,
                providerSessionId: input.providerSessionId,
                providerThreadId: threadInput.providerThread.id,
                cause,
              }),
          ),
        ),
    ),
    compactThread: (turnInput) =>
      runtimeSession.startTurn({
        ...turnInput,
        message: { ...turnInput.message, text: "/compact" },
      }),
    startTurn: Effect.fn("OpencodeAdapter.startTurn")(
      function* (turnInput) {
        if (m.nativeStreamFailure !== null) {
          return yield* protocolError(
            "OpenCode event stream has ended; reconnect the provider session before starting another turn.",
          );
        }
        const sessionId = nativeThreadId(turnInput.providerThread);
        const state = threads.get(sessionId);
        if (state === undefined) {
          return yield* protocolError(`OpenCode session ${sessionId} is not registered`);
        }
        if (state.activeTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode provider thread ${turnInput.providerThread.id} already has an active turn`,
            reason: "previous_turn_active",
          });
        }
        const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(
          turnInput.modelSelection.model,
        );
        if (parsedModel === null) {
          return yield* protocolError(
            `OpenCode model '${turnInput.modelSelection.model}' must use provider/model format`,
          );
        }
        yield* deps.applyPermissionRules(state, turnInput.runtimePolicy);
        const isCompaction =
          turnInput.message.text.trim() === "/compact" &&
          turnInput.message.attachments.length === 0;
        const parts = isCompaction ? [] : yield* deps.resolvePromptParts(turnInput);
        const startedAt = yield* DateTime.now;
        const syntheticNativeTurnId = `${sessionId}:attempt:${turnInput.attemptId}`;
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: OPENCODE_PROVIDER,
          nativeTurnId: syntheticNativeTurnId,
        });
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: providerTurnId,
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: providerRef(syntheticNativeTurnId, "weak"),
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const admissionMessageId = yield* makeOpenCodeMessageId(messageIdClock);
        // Do not yield before turn installation; EOF may otherwise finish scanning before registration.
        if (m.nativeStreamFailure !== null) {
          return yield* protocolError(
            "OpenCode event stream has ended; reconnect the provider session before starting another turn.",
          );
        }
        if (state.activeTurn !== null) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: OPENCODE_PROVIDER,
            detail: `OpenCode provider thread ${turnInput.providerThread.id} already has an active turn`,
            reason: "previous_turn_active",
          });
        }
        const turn: ActiveOpenCodeTurn = {
          isRoot: true,
          threadId: turnInput.threadId,
          runId: turnInput.runId,
          rootNodeId: turnInput.rootNodeId,
          appThread: turnInput.appThread,
          modelSelection: turnInput.modelSelection,
          runtimePolicy: turnInput.runtimePolicy,
          providerTurnId,
          providerThreadId: turnInput.providerThread.id,
          runOrdinal: turnInput.runOrdinal,
          startedAt,
          itemOrdinals: new Map(),
          usage: makeOpenCodeTurnTokenUsageAccumulator(),
          parts: new Map(),
          partIdsByMessage: new Map(),
          toolNamesByCallId: new Map(),
          providerTurn,
          nextItemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          nativeUserMessageId: null,
          admissionMessageId,
          interrupted: false,
          finalized: false,
          planId: null,
          admissionGeneration: state.nextAdmissionGeneration++,
          admissionReconciliationGeneration: null,
          admissionPending: !isCompaction,
          admissionAccepted: isCompaction,
          admissionMessageObserved: false,
          idleDuringAdmission: false,
          admissionSettled: Deferred.makeUnsafe<void>(),
          // @effect-diagnostics-next-line abortControllerInEffect:off - Turn interruption owns prompt admission cancellation.
          admissionAbortController: new AbortController(),
        };
        if (turn.admissionMessageId !== null)
          turn.usage.promptMessageIds.add(turn.admissionMessageId);
        const admissionSettled = turn.admissionSettled;
        const admissionAbortController = turn.admissionAbortController;
        state.appThread = turnInput.appThread;
        state.activeTurn = turn;
        state.providerTurns.set(String(providerTurnId), providerTurn);
        yield* deps.emitProviderTurn(state, turn, "running", null);
        yield* deps.updateProviderThread(state, {
          status: "active",
          firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
        });
        yield* deps.updateProviderSession("running", null);
        if (isCompaction) {
          yield* sdkCall(
            "session.summarize",
            { sessionID: sessionId, ...parsedModel, auto: false },
            (signal) =>
              client.session.summarize(
                { sessionID: sessionId, ...parsedModel, auto: false },
                { signal: AbortSignal.any([signal, admissionAbortController!.signal]) },
              ),
          ).pipe(
            Effect.tap(() =>
              turn.interrupted || turn.finalized || m.nativeStreamFailure !== null
                ? Effect.void
                : deps.emitCompactionItem(state, turn),
            ),
            Effect.tap(() =>
              deps.finalizeTurn(state, turn, turn.interrupted ? "interrupted" : "completed"),
            ),
            Effect.tapError((cause) =>
              deps.finalizeTurn(state, turn, turn.interrupted ? "interrupted" : "failed", {
                failure: makeProviderFailure({ cause, class: "provider_error" }),
              }),
            ),
            Effect.ensuring(Deferred.succeed(admissionSettled, undefined)),
          );
          return;
        }
        yield* deps.submitPrompt(
          state,
          turn,
          {
            sessionID: sessionId,
            messageID: turn.admissionMessageId!,
            model: parsedModel,
            ...deps.turnPromptOptions(turn),
            parts,
          },
          admissionAbortController!,
        ).pipe(
          Effect.tapError((cause) =>
            admissionAbortController!.signal.aborted
              ? Effect.void
              : deps.finalizeTurn(state, turn, "failed", {
                  failure: makeProviderFailure({ cause, class: "provider_error" }),
                }),
          ),
          Effect.catch((cause) =>
            admissionAbortController!.signal.aborted ? Effect.void : Effect.fail(cause),
          ),
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(admissionSettled, undefined).pipe(Effect.ignore),
              Effect.sync(() => {
                if (turn.admissionAbortController === admissionAbortController) {
                  turn.admissionAbortController = null;
                }
              }),
            ]).pipe(Effect.asVoid),
          ),
        );
        if (state.activeTurn === turn && !turn.finalized && !turn.interrupted) {
          const admissionAction = advanceOpenCodePromptAdmission(turn, "accepted");
          if (admissionAction === "reconcile-idle") {
            yield* deps.reconcilePromptAdmission(state, turn);
          }
        }
      },
      (effect, turnInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: OPENCODE_PROVIDER,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause,
              }),
          ),
        ),
    ),
    steerTurn: Effect.fn("OpencodeAdapter.steerTurn")(
      function* (steerInput) {
        const sessionId = nativeThreadId(steerInput.providerThread);
        const state = threads.get(sessionId);
        const turn = state?.activeTurn;
        if (
          state === undefined ||
          turn === undefined ||
          turn === null ||
          turn.providerTurnId !== steerInput.providerTurnId ||
          turn.interrupted
        ) {
          return yield* protocolError(
            `OpenCode turn ${steerInput.providerTurnId} is not active`,
          );
        }
        const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(turn.modelSelection.model);
        if (parsedModel === null) {
          return yield* protocolError(
            `OpenCode model '${turn.modelSelection.model}' must use provider/model format`,
          );
        }
        const text = (yield* providerMessageTextWithAttachmentPaths({
          text: steerInput.message.text,
          attachments: steerInput.message.attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        })).trim();
        if (state.activeTurn !== turn || turn.interrupted || turn.finalized) {
          return yield* protocolError(
            `OpenCode turn ${steerInput.providerTurnId} is not active`,
          );
        }
        const files = OpenCodeRuntime.toOpenCodeFileParts({
          attachments: steerInput.message.attachments,
          resolveAttachmentPath: host.resolveAttachmentPath,
        });
        if (text.length === 0 && files.length === 0) {
          return yield* protocolError("OpenCode steering requires text or an attachment");
        }
        const parts = [
          ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
          ...files,
        ];
        turn.admissionGeneration = state.nextAdmissionGeneration++;
        turn.admissionMessageId = yield* makeOpenCodeMessageId(messageIdClock);
        turn.admissionPending = true;
        turn.admissionAccepted = false;
        turn.admissionMessageObserved = false;
        turn.idleDuringAdmission = false;
        turn.admissionSettled = Deferred.makeUnsafe<void>();
        // @effect-diagnostics-next-line abortControllerInEffect:off - Steering replaces the admission request independently of this command fiber.
        turn.admissionAbortController = new AbortController();
        if (turn.admissionMessageId !== null)
          turn.usage.promptMessageIds.add(turn.admissionMessageId);
        const admissionSettled = turn.admissionSettled;
        const admissionAbortController = turn.admissionAbortController;
        yield* deps.submitPrompt(
          state,
          turn,
          {
            sessionID: sessionId,
            messageID: turn.admissionMessageId,
            model: parsedModel,
            ...deps.turnPromptOptions(turn),
            parts,
          },
          admissionAbortController!,
        ).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(admissionSettled, undefined).pipe(Effect.ignore),
              Effect.sync(() => {
                if (turn.admissionAbortController === admissionAbortController) {
                  turn.admissionAbortController = null;
                }
              }),
            ]).pipe(Effect.asVoid),
          ),
        );
        if (state.activeTurn === turn && !turn.finalized) {
          const admissionAction = advanceOpenCodePromptAdmission(turn, "accepted");
          if (admissionAction === "reconcile-idle") {
            yield* deps.reconcilePromptAdmission(state, turn);
          }
        }
      },
      (effect, steerInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterSteerRunError({
                driver: OPENCODE_PROVIDER,
                providerThreadId: steerInput.providerThread.id,
                providerTurnId: steerInput.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    interruptTurn: Effect.fn("OpencodeAdapter.interruptTurn")(
      function* (interruptInput) {
        const sessionId = nativeThreadId(interruptInput.providerThread);
        const state = threads.get(sessionId);
        const turn = state?.activeTurn;
        if (
          (turn === undefined || turn === null) &&
          interruptInput.requestRuntimeRestart === true
        ) {
          for (const controller of commandControllers.get(sessionId) ?? [])
            controller.abort();
          yield* abortDescendants(sessionId);
          return;
        }
        if (
          turn === undefined ||
          turn === null ||
          turn.providerTurnId !== interruptInput.providerTurnId
        ) {
          return yield* protocolError(
            `OpenCode turn ${interruptInput.providerTurnId} is not active`,
          );
        }
        turn.interrupted = true;
        for (const controller of commandControllers.get(sessionId) ?? []) controller.abort();
        const admissionWasPending = turn.admissionPending;
        cancelOpenCodePromptAdmission(turn, state!.nextAdmissionGeneration++);
        turn.admissionAbortController?.abort();
        if (admissionWasPending) {
          // Local admission timeout must not block the server-side abort.
          yield* Deferred.await(turn.admissionSettled).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          );
        }
        yield* sdkCall("session.abort", { sessionID: sessionId }, (signal) =>
          client.session.abort({ sessionID: sessionId }, { signal }),
        ).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch((cause) =>
            turn.finalized
              ? Effect.void
              : Effect.suspend(() => {
                  turn.interrupted = false;
                  return Effect.fail(cause);
                }),
          ),
        );
        // Root abort leaves children running; report incomplete cleanup even after root termination.
        yield* abortDescendants(sessionId);
      },
      (effect, interruptInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver: OPENCODE_PROVIDER,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause,
              }),
          ),
        ),
    ),
    respondToRuntimeRequest: Effect.fn("OpencodeAdapter.respondToRuntimeRequest")(
      function* (requestInput) {
        const pending = pendingRequests.get(String(requestInput.requestId));
        if (pending === undefined) {
          return yield* protocolError(
            `No pending OpenCode request ${requestInput.requestId}`,
          );
        }
        if (pending.question !== undefined) {
          if (requestInput.answers === undefined) {
            return yield* protocolError(
              `OpenCode question request ${requestInput.requestId} requires answers`,
            );
          }
          const answers = OpenCodeRuntime.toOpenCodeQuestionAnswers(
            pending.question,
            requestInput.answers,
          );
          yield* sdkCall(
            "question.reply",
            { requestID: pending.nativeRequestId, answers },
            (signal) =>
              client.question.reply(
                {
                  requestID: pending.nativeRequestId,
                  answers,
                },
                { signal },
              ),
          ).pipe(Effect.timeout("10 seconds"));
          return;
        }
        if (requestInput.decision === undefined) {
          return yield* protocolError(
            `OpenCode approval request ${requestInput.requestId} requires a decision`,
          );
        }
        const reply = OpenCodeRuntime.toOpenCodePermissionReply(requestInput.decision);
        yield* sdkCall(
          "permission.reply",
          { requestID: pending.nativeRequestId, reply },
          (signal) =>
            client.permission.reply(
              {
                requestID: pending.nativeRequestId,
                reply,
              },
              { signal },
            ),
        ).pipe(Effect.timeout("10 seconds"));
      },
      (effect, requestInput) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: OPENCODE_PROVIDER,
                requestId: requestInput.requestId,
                cause,
              }),
          ),
        ),
    ),
    readThreadSnapshot: (snapshotInput) =>
      deps.readSnapshot(snapshotInput.providerThread).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: OPENCODE_PROVIDER,
              providerThreadId: snapshotInput.providerThread.id,
              cause,
            }),
        ),
      ),
  };
  return runtimeSession;
};
