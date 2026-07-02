import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";
import { parsePermissionRequest } from "./AcpRuntimeModel.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

export interface AcpAdapterPromptContext {
  readonly acpSessionId: string;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  promptsInFlight: number;
}

export interface AcpAdapterPromptTurnStore {
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
}

export interface AcpAdapterSessionContext
  extends AcpAdapterPromptContext, AcpAdapterPromptTurnStore {
  readonly threadId: ThreadId;
  lastPlanFingerprint: string | undefined;
}

export interface AcpAdapterEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface AcpPromptSettlementOptions {
  readonly errorMessage?: string;
  readonly completedStopReason?: EffectAcpSchema.StopReason | null;
  readonly emitTurnCompletion?: boolean;
  /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
  readonly settleAllPrompts?: boolean;
}

export interface AcpAdapterPendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export type AcpAdapterPendingUserInputResolution<Response> =
  | {
      readonly _tag: "answered";
      readonly answers: ProviderUserInputAnswers;
      readonly response: Response;
    }
  | { readonly _tag: "cancelled" };

export interface AcpAdapterPendingUserInput<Response> {
  readonly resolution: Deferred.Deferred<AcpAdapterPendingUserInputResolution<Response>>;
  readonly makeResponse: (answers: ProviderUserInputAnswers) => Response;
  readonly validateResponse?: (response: Response) => string | undefined;
}

export interface AcpAdapterUserInputPrompt<Response> {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly makeResponse: (answers: ProviderUserInputAnswers) => Response;
  readonly makeCancelledResponse: () => Response;
  readonly validateResponse?: (response: Response) => string | undefined;
}

type AcpAdapterRuntimeEventSource = "acp.jsonrpc" | `acp.${string}.extension`;

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpResume(
  raw: unknown,
  schemaVersion: number,
): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== schemaVersion) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export function settlePendingAcpApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, AcpAdapterPendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function settlePendingAcpUserInputsAsCancelled<Response>(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, AcpAdapterPendingUserInput<Response>>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

export function makeAcpPlanUpdateEmitter<EOffer = never, ROffer = never>(input: {
  readonly provider: ProviderDriverKind;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
}) {
  return (
    ctx: AcpAdapterSessionContext,
    turnId: TurnId | undefined,
    stamp: AcpAdapterEventStamp,
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: unknown,
    method: string,
  ) =>
    Effect.gen(function* () {
      const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
      if (ctx.lastPlanFingerprint === fingerprint) {
        return;
      }
      ctx.lastPlanFingerprint = fingerprint;
      yield* input.offerRuntimeEvent(
        makeAcpPlanUpdatedEvent({
          stamp,
          provider: input.provider,
          threadId: ctx.threadId,
          turnId,
          payload,
          source: "acp.jsonrpc",
          method,
          rawPayload,
        }),
      );
    });
}

export function forkAcpAdapterNotificationStream<
  Ctx extends AcpAdapterSessionContext,
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
  ELog = never,
  RLog = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly ctx: Ctx;
  readonly events: Stream.Stream<AcpSessionRuntimeEvent, never>;
  readonly makeEventStamp: () => Effect.Effect<AcpAdapterEventStamp, EStamp, RStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, ELog, RLog>;
  readonly logErrorMessage: string;
}) {
  const emitPlanUpdate = makeAcpPlanUpdateEmitter({
    provider: input.provider,
    offerRuntimeEvent: input.offerRuntimeEvent,
  });

  return Stream.runDrain(
    Stream.mapEffect(input.events, (event) =>
      Effect.gen(function* () {
        if (event._tag === "EventStreamBarrier") {
          yield* Deferred.succeed(event.acknowledge, undefined);
          return;
        }
        if (
          event._tag === "PlanUpdated" ||
          event._tag === "ToolCallUpdated" ||
          event._tag === "ContentDelta"
        ) {
          yield* input.logNative(input.ctx.threadId, "session/update", event.rawPayload);
        }

        if (event._tag === "ModeChanged") {
          return;
        }

        const notificationTurnId = input.ctx.activeTurnId;
        if (
          notificationTurnId === undefined ||
          input.ctx.interruptedTurnIds.has(notificationTurnId)
        ) {
          return;
        }
        const stamp = yield* input.makeEventStamp();

        switch (event._tag) {
          case "AssistantItemStarted":
            yield* input.offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: input.provider,
                threadId: input.ctx.threadId,
                turnId: notificationTurnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            yield* input.offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: input.provider,
                threadId: input.ctx.threadId,
                turnId: notificationTurnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "PlanUpdated":
            yield* emitPlanUpdate(
              input.ctx,
              notificationTurnId,
              stamp,
              event.payload,
              event.rawPayload,
              "session/update",
            );
            return;
          case "ToolCallUpdated":
            yield* input.offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp,
                provider: input.provider,
                threadId: input.ctx.threadId,
                turnId: notificationTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ContentDelta":
            yield* input.offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp,
                provider: input.provider,
                threadId: input.ctx.threadId,
                turnId: notificationTurnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
        }
      }),
    ),
  ).pipe(
    Effect.catch((cause) => Effect.logError(input.logErrorMessage, { cause })),
    Effect.forkChild,
  );
}

export function emitAcpSessionReadyEvents<
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: string;
  readonly initializeResult: unknown;
  readonly readyReason: string;
  readonly makeEventStamp: () => Effect.Effect<AcpAdapterEventStamp, EStamp, RStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
}) {
  return Effect.gen(function* () {
    yield* input.offerRuntimeEvent({
      type: "session.started",
      ...(yield* input.makeEventStamp()),
      provider: input.provider,
      threadId: input.threadId,
      payload: { resume: input.initializeResult },
    });
    yield* input.offerRuntimeEvent({
      type: "session.state.changed",
      ...(yield* input.makeEventStamp()),
      provider: input.provider,
      threadId: input.threadId,
      payload: { state: "ready", reason: input.readyReason },
    });
    yield* input.offerRuntimeEvent({
      type: "thread.started",
      ...(yield* input.makeEventStamp()),
      provider: input.provider,
      threadId: input.threadId,
      payload: { providerThreadId: input.providerThreadId },
    });
  });
}

export function handleAcpPermissionRequest<
  ERequestId = never,
  RRequestId = never,
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
  ELog = never,
  RLog = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly pendingApprovals: Map<ApprovalRequestId, AcpAdapterPendingApproval>;
  readonly resolveTurnId: () => TurnId | undefined;
  readonly makeRequestId: Effect.Effect<ApprovalRequestId, ERequestId, RRequestId>;
  readonly makeEventStamp: () => Effect.Effect<AcpAdapterEventStamp, EStamp, RStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, ELog, RLog>;
}) {
  return Effect.gen(function* () {
    yield* input.logNative(input.threadId, "session/request_permission", input.request);
    if (input.runtimeMode === "full-access") {
      const autoApprovedOptionId = selectAutoApprovedPermissionOption(input.request);
      if (autoApprovedOptionId !== undefined) {
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: autoApprovedOptionId,
          },
        };
      }
    }
    const permissionRequest = parsePermissionRequest(input.request);
    const requestId = yield* input.makeRequestId;
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const decision = yield* Deferred.make<ProviderApprovalDecision>();
    const turnId = input.resolveTurnId();
    input.pendingApprovals.set(requestId, { decision });
    yield* input.offerRuntimeEvent(
      makeAcpRequestOpenedEvent({
        stamp: yield* input.makeEventStamp(),
        provider: input.provider,
        threadId: input.threadId,
        turnId,
        requestId: runtimeRequestId,
        permissionRequest,
        detail:
          permissionRequest.detail ??
          encodeJsonStringForDiagnostics(input.request)?.slice(0, 2000) ??
          "[unserializable params]",
        args: input.request,
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: input.request,
      }),
    );
    const resolved = yield* Deferred.await(decision);
    input.pendingApprovals.delete(requestId);
    yield* input.offerRuntimeEvent(
      makeAcpRequestResolvedEvent({
        stamp: yield* input.makeEventStamp(),
        provider: input.provider,
        threadId: input.threadId,
        turnId,
        requestId: runtimeRequestId,
        permissionRequest,
        decision: resolved,
      }),
    );
    const selectedOptionId =
      resolved === "cancel" ? undefined : selectPermissionOptionId(input.request, resolved);
    return {
      outcome: selectedOptionId
        ? {
            outcome: "selected" as const,
            optionId: selectedOptionId,
          }
        : ({ outcome: "cancelled" } as const),
    };
  });
}

export function respondToAcpPermissionRequest(input: {
  readonly provider: ProviderDriverKind;
  readonly requestId: ApprovalRequestId;
  readonly decision: ProviderApprovalDecision;
  readonly pendingApprovals: ReadonlyMap<ApprovalRequestId, AcpAdapterPendingApproval>;
}) {
  return Effect.gen(function* () {
    const pending = input.pendingApprovals.get(input.requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: input.provider,
        method: "session/request_permission",
        detail: `Unknown pending approval request: ${input.requestId}`,
      });
    }
    yield* Deferred.succeed(pending.decision, input.decision);
  });
}

export function handleAcpUserInputRequest<
  Response,
  ERequestId = never,
  RRequestId = never,
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
  ELog = never,
  RLog = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly method: string;
  readonly source: AcpAdapterRuntimeEventSource;
  readonly request: unknown;
  readonly prompt: AcpAdapterUserInputPrompt<Response>;
  readonly pendingUserInputs: Map<ApprovalRequestId, AcpAdapterPendingUserInput<Response>>;
  readonly resolveTurnId: () => TurnId | undefined;
  readonly makeRequestId: Effect.Effect<ApprovalRequestId, ERequestId, RRequestId>;
  readonly makeEventStamp: () => Effect.Effect<AcpAdapterEventStamp, EStamp, RStamp>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, ELog, RLog>;
}) {
  return Effect.gen(function* () {
    yield* input.logNative(input.threadId, input.method, input.request);
    const requestId = yield* input.makeRequestId;
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const resolution = yield* Deferred.make<AcpAdapterPendingUserInputResolution<Response>>();
    const turnId = input.resolveTurnId();
    input.pendingUserInputs.set(requestId, {
      resolution,
      makeResponse: input.prompt.makeResponse,
      ...(input.prompt.validateResponse ? { validateResponse: input.prompt.validateResponse } : {}),
    });
    yield* input.offerRuntimeEvent({
      type: "user-input.requested",
      ...(yield* input.makeEventStamp()),
      provider: input.provider,
      threadId: input.threadId,
      turnId,
      requestId: runtimeRequestId,
      payload: { questions: input.prompt.questions },
      raw: {
        source: input.source,
        method: input.method,
        payload: input.request,
      },
    });
    const resolved = yield* Deferred.await(resolution);
    input.pendingUserInputs.delete(requestId);
    const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
    yield* input.offerRuntimeEvent({
      type: "user-input.resolved",
      ...(yield* input.makeEventStamp()),
      provider: input.provider,
      threadId: input.threadId,
      turnId,
      requestId: runtimeRequestId,
      payload: { answers: resolvedAnswers },
      raw: {
        source: input.source,
        method: input.method,
        payload: input.request,
      },
    });
    return resolved._tag === "answered" ? resolved.response : input.prompt.makeCancelledResponse();
  });
}

export function respondToAcpUserInput<Response>(input: {
  readonly provider: ProviderDriverKind;
  readonly method: string;
  readonly requestId: ApprovalRequestId;
  readonly answers: ProviderUserInputAnswers;
  readonly pendingUserInputs: ReadonlyMap<ApprovalRequestId, AcpAdapterPendingUserInput<Response>>;
}) {
  return Effect.gen(function* () {
    const pending = input.pendingUserInputs.get(input.requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: input.provider,
        method: input.method,
        detail: `Unknown pending user-input request: ${input.requestId}`,
      });
    }
    const response = pending.makeResponse(input.answers);
    const validationError = pending.validateResponse?.(response);
    if (validationError !== undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: input.provider,
        method: input.method,
        detail: validationError,
      });
    }
    yield* Deferred.succeed(pending.resolution, {
      _tag: "answered",
      answers: input.answers,
      response,
    });
  });
}

export function prepareAcpPromptContent(input: {
  readonly provider: ProviderDriverKind;
  readonly text: string | undefined;
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  return Effect.gen(function* () {
    const text = input.text?.trim();
    const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: input.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: input.provider,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: input.provider,
                method: "session/prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        return {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        } satisfies EffectAcpSchema.ContentBlock;
      }),
    );
    const promptParts: Array<EffectAcpSchema.ContentBlock> = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...imagePromptParts,
    ];

    if (promptParts.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: input.provider,
        operation: "sendTurn",
        issue: "Turn requires non-empty text or attachments.",
      });
    }

    return promptParts;
  });
}

export function appendPromptResultToTurn(
  ctx: AcpAdapterPromptTurnStore,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

export function acpPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export const makeAcpThreadLock = Effect.fn("makeAcpThreadLock")(function* () {
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(threadId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  return <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));
});

export function makeAcpPromptSettler<
  Ctx extends AcpAdapterPromptContext,
  ENow = never,
  RNow = never,
  EStamp = never,
  RStamp = never,
  EOffer = never,
  ROffer = never,
>(input: {
  readonly provider: ProviderDriverKind;
  readonly sessions: ReadonlyMap<ThreadId, Ctx>;
  readonly nowIso: Effect.Effect<string, ENow, RNow>;
  readonly makeEventStamp: () => Effect.Effect<
    {
      readonly eventId: EventId;
      readonly createdAt: string;
    },
    EStamp,
    RStamp
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, EOffer, ROffer>;
}) {
  return (
    threadId: ThreadId,
    turnId: TurnId,
    expectedAcpSessionId: string,
    options?: AcpPromptSettlementOptions,
  ) =>
    Effect.gen(function* () {
      const liveCtx = input.sessions.get(threadId);
      if (!liveCtx) {
        return;
      }
      const settlementBelongsToLiveContext = acpPromptSettlementBelongsToContext({
        liveAcpSessionId: liveCtx.acpSessionId,
        expectedAcpSessionId,
        liveActiveTurnId: liveCtx.activeTurnId,
        liveSessionActiveTurnId: liveCtx.session.activeTurnId,
        turnId,
      });
      if (!settlementBelongsToLiveContext) {
        if (
          liveCtx.acpSessionId !== expectedAcpSessionId ||
          liveCtx.interruptedTurnIds.has(turnId)
        ) {
          return;
        }
        if (options?.emitTurnCompletion !== false) {
          if (options?.errorMessage !== undefined) {
            yield* input.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* input.makeEventStamp()),
              provider: input.provider,
              threadId,
              turnId,
              payload: {
                state: "failed",
                errorMessage: options.errorMessage,
              },
            });
          } else if (options?.completedStopReason !== undefined) {
            yield* input.offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* input.makeEventStamp()),
              provider: input.provider,
              threadId,
              turnId,
              payload: {
                state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: options.completedStopReason ?? null,
              },
            });
          }
        }
        return;
      }
      let settleTurnId = turnId;
      if (options?.settleAllPrompts) {
        liveCtx.promptsInFlight = 0;
        if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
          const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
          if (!fallbackTurnId) {
            if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
              const updatedAt = yield* input.nowIso;
              const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
              liveCtx.activeTurnId = undefined;
              liveCtx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
            return;
          }
          settleTurnId = fallbackTurnId;
        }
      } else {
        const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
        if (
          remainingPrompts > 0 ||
          liveCtx.activeTurnId !== settleTurnId ||
          liveCtx.session.activeTurnId !== settleTurnId
        ) {
          liveCtx.promptsInFlight = remainingPrompts;
          return;
        }
        liveCtx.promptsInFlight = remainingPrompts;
      }
      const updatedAt = yield* input.nowIso;
      const canEmitTurnCompletion =
        liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
      const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
      const shouldEmitCompletedTurn =
        options?.completedStopReason !== undefined && canEmitTurnCompletion;
      const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
      liveCtx.activeTurnId = undefined;
      liveCtx.session = {
        ...readySession,
        status: "ready",
        updatedAt,
      };
      if (options?.emitTurnCompletion === false) {
        return;
      }
      if (shouldEmitFailedTurn) {
        yield* input.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: "failed",
            errorMessage: options.errorMessage,
          },
        });
      } else if (shouldEmitCompletedTurn) {
        yield* input.offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* input.makeEventStamp()),
          provider: input.provider,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: options.completedStopReason ?? null,
          },
        });
      }
    });
}
