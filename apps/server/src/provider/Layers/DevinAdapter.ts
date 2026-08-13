import {
  ApprovalRequestId,
  type DevinSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type UsageTokenTotals,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyDevinAcpModelSelection,
  currentDevinAcpModelSelection,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpModelSelection,
} from "../acp/DevinAcpSupport.ts";
import { resolveDevinUsageTranscriptPath } from "../Drivers/DevinHome.ts";
import { type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DevinAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface DevinSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  currentReasoningValue: string | undefined;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  /** Last usage received from ACP (PromptResponse or UsageUpdated). */
  lastAcpUsage: EffectAcpSchema.Usage | undefined;
  /** Last usage that was actually persisted to the Devin usage transcript. */
  lastWrittenAcpUsage: EffectAcpSchema.Usage | undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: DevinSessionContext,
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

const resolveNotificationTurnId = (ctx: DevinSessionContext): TurnId | undefined =>
  ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: DevinSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, DevinSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

const DevinResume = Schema.Struct({
  schemaVersion: Schema.Literal(DEVIN_RESUME_VERSION),
  sessionId: Schema.String,
});

const decodeDevinResume = Schema.decodeUnknownOption(DevinResume);

function parseDevinResume(raw: unknown): { sessionId: string } | undefined {
  const result = decodeDevinResume(raw);
  if (Option.isNone(result)) return undefined;
  const sessionId = result.value.sessionId.trim();
  if (sessionId.length === 0) return undefined;
  return { sessionId };
}

function selectPermissionOptionId(
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

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  return response?.stopReason ?? null;
}

export function devinPromptSettlementBelongsToContext(input: {
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

function finiteNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int >= 0 ? int : undefined;
}

function finiteNonNegativeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): number {
  const delta = (current ?? 0) - (previous ?? 0);
  return Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 0;
}

function devinUsageDeltaTotals(
  current: EffectAcpSchema.Usage,
  previous: EffectAcpSchema.Usage | undefined,
): UsageTokenTotals {
  const inputTokens = finiteNonNegativeDelta(current.inputTokens, previous?.inputTokens);
  const cachedReadTokens = finiteNonNegativeDelta(
    current.cachedReadTokens,
    previous?.cachedReadTokens,
  );
  const cachedWriteTokens = finiteNonNegativeDelta(
    current.cachedWriteTokens,
    previous?.cachedWriteTokens,
  );
  const outputTokens = finiteNonNegativeDelta(current.outputTokens, previous?.outputTokens);
  const thoughtTokens = finiteNonNegativeDelta(current.thoughtTokens, previous?.thoughtTokens);

  // Input tokens reported by Devin are inclusive of any cached read and write
  // tokens, matching the other transcript parsers.
  const uncachedInputTokens = Math.max(0, inputTokens - cachedReadTokens - cachedWriteTokens);

  return {
    uncachedInputTokens,
    cachedInputTokens: cachedReadTokens,
    cacheCreationTokens: cachedWriteTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, thoughtTokens),
  };
}

export function usageFromUsageUpdate(
  event: Extract<AcpParsedSessionEvent, { readonly _tag: "UsageUpdated" }>,
): EffectAcpSchema.Usage {
  const outputTokens = event.outputTokens ?? 0;
  return {
    inputTokens:
      event.inputTokens ??
      (event.outputTokens !== undefined ? Math.max(0, event.used - outputTokens) : event.used),
    outputTokens,
    totalTokens: event.used,
    cachedReadTokens: event.cachedReadTokens ?? null,
    cachedWriteTokens: null,
    thoughtTokens: null,
  };
}

export function isAcpUsageGreaterOrNew(
  current: EffectAcpSchema.Usage | undefined,
  next: EffectAcpSchema.Usage,
): boolean {
  if (!current) return true;
  if (next.totalTokens !== current.totalTokens) {
    return next.totalTokens > current.totalTokens;
  }
  return (
    next.inputTokens !== current.inputTokens ||
    next.outputTokens !== current.outputTokens ||
    next.cachedReadTokens !== current.cachedReadTokens ||
    next.cachedWriteTokens !== current.cachedWriteTokens ||
    next.thoughtTokens !== current.thoughtTokens
  );
}

interface DevinUsageTranscriptRecord {
  readonly timestamp: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
}

function writeDevinUsageTranscriptLine(
  config: Pick<DevinSettings, "homePath">,
  record: DevinUsageTranscriptRecord,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> {
  let filePath: string | undefined;
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    filePath = yield* resolveDevinUsageTranscriptPath(config);
    const line = yield* encodeUnknownJsonString({
      type: "devin_usage",
      ...record,
    }).pipe(
      Effect.map((json) => `${json}\n`),
      Effect.orElseSucceed(() => "[unserializable]\n"),
    );
    const dir = path.dirname(filePath);
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    yield* fileSystem.writeFileString(filePath, line, { flag: "a" });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to append Devin usage transcript", {
        filePath: filePath ?? "[unknown]",
        error: error.message,
      }),
    ),
    Effect.catchCause(() => Effect.void),
  );
}

export function makeDevinTokenUsageSnapshot(
  usage: EffectAcpSchema.Usage | null | undefined,
  previous: ThreadTokenUsageSnapshot | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokens = finiteNonNegativeInteger(usage.inputTokens);
  const outputTokens = finiteNonNegativeInteger(usage.outputTokens);
  const totalTokens = finiteNonNegativeInteger(usage.totalTokens);
  const usedTokens =
    totalTokens !== undefined && totalTokens > 0
      ? totalTokens
      : (inputTokens ?? 0) + (outputTokens ?? 0);

  if (usedTokens <= 0) {
    return undefined;
  }

  const cachedReadTokens = finiteNonNegativeInteger(usage.cachedReadTokens);
  const thoughtTokens = finiteNonNegativeInteger(usage.thoughtTokens);

  const contextUsedTokens = previous?.usedTokens ?? usedTokens;
  const contextMaxTokens = previous?.maxTokens;
  const previousTotalProcessed = previous?.totalProcessedTokens ?? 0;
  const lastUsedTokens = Math.max(0, usedTokens - previousTotalProcessed);

  return {
    usedTokens: contextUsedTokens,
    totalProcessedTokens: usedTokens,
    ...(contextMaxTokens !== undefined ? { maxTokens: contextMaxTokens } : {}),
    lastUsedTokens,
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(cachedReadTokens !== undefined && cachedReadTokens > 0
      ? { cachedInputTokens: cachedReadTokens }
      : {}),
    ...(thoughtTokens !== undefined && thoughtTokens > 0
      ? { reasoningOutputTokens: thoughtTokens }
      : {}),
  };
}

export function makeDevinTokenUsageSnapshotFromUsageUpdate(
  usage: Extract<AcpParsedSessionEvent, { readonly _tag: "UsageUpdated" }>,
  previous: ThreadTokenUsageSnapshot | undefined,
): ThreadTokenUsageSnapshot | undefined {
  const usedTokens =
    usage.used > 0 ? usage.used : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

  if (usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.size > 0 ? usage.size : undefined;

  return buildThreadTokenUsageSnapshot({
    usedTokens,
    maxTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cachedReadTokens,
    thoughtTokens: undefined,
    previous,
  });
}

function buildThreadTokenUsageSnapshot(input: {
  readonly usedTokens: number;
  readonly maxTokens?: number | undefined;
  readonly totalProcessedTokens?: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedReadTokens: number | undefined;
  readonly thoughtTokens: number | undefined;
  readonly previous: ThreadTokenUsageSnapshot | undefined;
}): ThreadTokenUsageSnapshot {
  const previousUsedTokens = input.previous?.usedTokens ?? 0;
  const previousTotalProcessed = input.previous?.totalProcessedTokens ?? 0;

  const maxTokens =
    input.maxTokens !== undefined && input.maxTokens > 0 ? input.maxTokens : undefined;

  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const cachedReadTokens = input.cachedReadTokens ?? 0;
  const turnTokens = inputTokens + outputTokens + cachedReadTokens;
  const usedDelta = Math.max(0, input.usedTokens - previousUsedTokens);

  const totalProcessedTokens =
    input.totalProcessedTokens ??
    (turnTokens > 0 ? previousTotalProcessed + turnTokens : previousTotalProcessed + usedDelta);

  return {
    usedTokens: input.usedTokens,
    totalProcessedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedDelta,
    ...(input.inputTokens !== undefined && input.inputTokens > 0
      ? {
          inputTokens: input.inputTokens,
          lastInputTokens: input.inputTokens,
        }
      : {}),
    ...(input.outputTokens !== undefined && input.outputTokens > 0
      ? {
          outputTokens: input.outputTokens,
          lastOutputTokens: input.outputTokens,
        }
      : {}),
    ...(input.cachedReadTokens !== undefined && input.cachedReadTokens > 0
      ? {
          cachedInputTokens: input.cachedReadTokens,
          lastCachedInputTokens: input.cachedReadTokens,
        }
      : {}),
    ...(input.thoughtTokens !== undefined && input.thoughtTokens > 0
      ? {
          reasoningOutputTokens: input.thoughtTokens,
          lastReasoningOutputTokens: input.thoughtTokens,
        }
      : {}),
  };
}

export const makeDevinAdapter = Effect.fn("makeDevinAdapter")(function* (
  devinSettings: DevinSettings,
  options?: DevinAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

  const sessions = new Map<ThreadId, DevinSessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Devin runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
  const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to process Devin ACP callback.",
            cause,
          }),
      ),
    );

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

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

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const settlePromptInFlight = (
    threadId: ThreadId,
    turnId: TurnId,
    expectedAcpSessionId: string,
    options?: {
      readonly errorMessage?: string;
      readonly completedStopReason?: EffectAcpSchema.StopReason | null;
      readonly emitTurnCompletion?: boolean;
      /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
      readonly settleAllPrompts?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const liveCtx = sessions.get(threadId);
      if (!liveCtx) {
        return;
      }
      const settlementBelongsToLiveContext = devinPromptSettlementBelongsToContext({
        liveAcpSessionId: liveCtx.acpSessionId,
        expectedAcpSessionId,
        liveActiveTurnId: liveCtx.activeTurnId,
        liveSessionActiveTurnId: liveCtx.session.activeTurnId,
        turnId,
      });
      if (!settlementBelongsToLiveContext) {
        // interruptTurn already consumed every prompt slot for this turn. A
        // late prompt result must neither emit a second terminal event nor
        // consume a slot belonging to a newer turn on the same ACP session.
        if (
          liveCtx.acpSessionId !== expectedAcpSessionId ||
          liveCtx.interruptedTurnIds.has(turnId)
        ) {
          return;
        }
        if (options?.emitTurnCompletion !== false) {
          if (options?.errorMessage !== undefined) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId,
              payload: {
                state: "failed",
                errorMessage: options.errorMessage,
              },
            });
          } else if (options?.completedStopReason !== undefined) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
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
              const updatedAt = yield* nowIso;
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
      const updatedAt = yield* nowIso;
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
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: "failed",
            errorMessage: options.errorMessage,
          },
        });
      } else if (shouldEmitCompletedTurn) {
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId,
          turnId: settleTurnId,
          payload: {
            state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: options.completedStopReason ?? null,
          },
        });
      }
    });

  const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
    Effect.gen(function* () {
      if (!nativeEventLogger) return;
      const observedAt = yield* nowIso;
      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* randomUUIDv4,
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method,
            threadId,
            payload,
          },
        },
        threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to write native Devin notification log.", {
          cause,
          threadId,
          method,
        }),
      ),
    );

  const emitPlanUpdate = (
    ctx: DevinSessionContext,
    turnId: TurnId | undefined,
    stamp: { readonly eventId: EventId; readonly createdAt: string },
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
      yield* offerRuntimeEvent(
        makeAcpPlanUpdatedEvent({
          stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload,
          source: "acp.jsonrpc",
          method,
          rawPayload,
        }),
      );
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(ctx);
  };

  const stopSessionInternal = (ctx: DevinSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
      yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
      if (ctx.notificationFiber) {
        yield* Fiber.interrupt(ctx.notificationFiber);
      }
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      sessions.delete(ctx.threadId);
      yield* SynchronizedRef.update(threadLocksRef, (current) => {
        const next = new Map(current);
        next.delete(ctx.threadId);
        return next;
      });
      yield* offerRuntimeEvent({
        type: "session.exited",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const startSession: DevinAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const cwd = path.resolve(input.cwd.trim());
        const devinModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        });

        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const acp = yield* makeDevinAcpRuntime({
          devinSettings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(mcpSession
            ? {
                mcpServers: [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [
                      {
                        name: "Authorization",
                        value: mcpSession.authorizationHeader,
                      },
                    ],
                  },
                ],
              }
            : {}),
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const started = yield* Effect.gen(function* () {
          yield* acp.handleRequestPermission((params) =>
            mapAcpCallbackFailure(
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const selectedOptionId =
                  resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                return {
                  outcome: selectedOptionId
                    ? {
                        outcome: "selected" as const,
                        optionId: selectedOptionId,
                      }
                    : ({ outcome: "cancelled" } as const),
                };
              }),
            ),
          );
          const started = yield* acp.start();
          return started;
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const requestedStartModel = resolveDevinAcpModelSelection(devinModelSelection);
        const boundModel = yield* applyDevinAcpModelSelection<ProviderAdapterError>({
          runtime: acp,
          current: currentDevinAcpModelSelection(started.sessionSetupResult),
          requested: requestedStartModel,
          configOptions: started.sessionSetupResult.configOptions ?? [],
          mapError: (cause) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
        });

        const now = yield* nowIso;
        const sessionModel =
          boundModel?.familySlug ?? resolveDevinAcpBaseModelId(devinModelSelection?.model);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(sessionModel ? { model: sessionModel } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: DEVIN_RESUME_VERSION,
            sessionId: started.sessionId,
          },
          createdAt: now,
          updatedAt: now,
        };

        const ctx: DevinSessionContext = {
          threadId: input.threadId,
          acpSessionId: started.sessionId,
          session,
          sessionSetupResult: started.sessionSetupResult,
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          lastPlanFingerprint: undefined,
          activeTurnId: undefined,
          interruptedTurnIds: new Set(),
          promptsInFlight: 0,
          currentModelId: boundModel?.familySlug,
          currentReasoningValue: boundModel?.reasoningValue,
          stopped: false,
          lastKnownTokenUsage: undefined,
          lastAcpUsage: undefined,
          lastWrittenAcpUsage: undefined,
        };

        const nf = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
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
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
              }

              if (event._tag === "ModeChanged") {
                return;
              }

              const notificationTurnId = resolveNotificationTurnId(ctx);
              if (
                notificationTurnId === undefined ||
                ctx.interruptedTurnIds.has(notificationTurnId)
              ) {
                return;
              }
              const stamp = yield* makeEventStamp();

              switch (event._tag) {
                case "AssistantItemStarted":
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.started",
                    }),
                  );
                  return;
                case "AssistantItemCompleted":
                  yield* offerRuntimeEvent(
                    makeAcpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  yield* emitPlanUpdate(
                    ctx,
                    notificationTurnId,
                    stamp,
                    event.payload,
                    event.rawPayload,
                    "session/update",
                  );
                  return;
                case "ToolCallUpdated":
                  yield* offerRuntimeEvent(
                    makeAcpToolCallEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  yield* offerRuntimeEvent(
                    makeAcpContentDeltaEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "UsageUpdated": {
                  const tokenUsage = makeDevinTokenUsageSnapshotFromUsageUpdate(
                    event,
                    ctx.lastKnownTokenUsage,
                  );
                  if (!tokenUsage) {
                    return;
                  }
                  ctx.lastKnownTokenUsage = tokenUsage;

                  const acpUsage = usageFromUsageUpdate(event);
                  if (isAcpUsageGreaterOrNew(ctx.lastAcpUsage, acpUsage)) {
                    ctx.lastAcpUsage = acpUsage;
                  }

                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...stamp,
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: notificationTurnId,
                    payload: { usage: tokenUsage },
                  });
                  return;
                }
              }
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to process Devin runtime notification.", {
              cause,
            }),
          ),
          Effect.forkIn(sessionScope),
        );

        ctx.notificationFiber = nf;
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Devin ACP session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });

        return session;
      }).pipe(Effect.scoped),
    );

  const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const prepared = yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          // A sendTurn while a prompt is in flight is a steer: the agent
          // folds the new prompt into the ongoing work, so the active turn
          // id is reused instead of opening a new turn.
          const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
          const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
          // Count this prompt immediately so a superseded in-flight prompt
          // resolving from here on does not settle the turn; decremented on
          // preparation failure here, and after the prompt below otherwise.
          ctx.promptsInFlight += 1;
          // Bind the turn id before cooperative yields so interruptTurn can
          // settle this prompt even if stop arrives during preparation.
          ctx.activeTurnId = turnId;
          ctx.session = {
            ...ctx.session,
            status: steeringTurnId === undefined ? "connecting" : "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          return yield* Effect.gen(function* () {
            const text = input.input?.trim();
            const imagePromptParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
              Effect.gen(function* () {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!attachmentPath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
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
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            const turnModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const requestedTurnModel = resolveDevinAcpModelSelection(turnModelSelection);
            const currentModel = yield* applyDevinAcpModelSelection<ProviderAdapterError>({
              runtime: ctx.acp,
              current:
                ctx.currentModelId === undefined
                  ? undefined
                  : {
                      familySlug: ctx.currentModelId,
                      reasoningValue: ctx.currentReasoningValue,
                    },
              requested: requestedTurnModel,
              configOptions: ctx.sessionSetupResult.configOptions ?? [],
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            });

            ctx.currentModelId = currentModel?.familySlug;
            ctx.currentReasoningValue = currentModel?.reasoningValue;
            const displayModel =
              (turnModelSelection?.model ?? currentModel?.familySlug)
                ? resolveDevinAcpBaseModelId(
                    turnModelSelection?.model ?? currentModel?.familySlug ?? undefined,
                  )
                : undefined;
            for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
              yield* Effect.yieldNow;
            }
            if (ctx.interruptedTurnIds.has(turnId)) {
              yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                emitTurnCompletion: false,
                settleAllPrompts: true,
              });
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Devin prompt was interrupted during preparation.",
              });
            }
            if (steeringTurnId === undefined) {
              ctx.lastPlanFingerprint = undefined;
            }
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(displayModel ? { model: displayModel } : {}),
            };

            if (steeringTurnId === undefined) {
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: displayModel ? { model: displayModel } : {},
              });
            }

            return {
              acp: ctx.acp,
              acpSessionId: ctx.acpSessionId,
              displayModel,
              promptParts,
              turnId,
            };
          }).pipe(
            Effect.tapCause(() =>
              Effect.gen(function* () {
                const liveCtx = sessions.get(input.threadId);
                if (!liveCtx) {
                  return;
                }
                yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                  errorMessage: "Devin prompt preparation failed.",
                  emitTurnCompletion: false,
                });
              }),
            ),
          );
        }),
      );
      const promptSettled = yield* Ref.make(false);
      const promptRpcSucceeded = yield* Ref.make(false);
      const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
        undefined,
      );

      const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

      return yield* Effect.gen(function* () {
        const result = yield* prepared.acp
          .prompt({
            prompt: prepared.promptParts,
          })
          .pipe(
            Effect.tap((promptResult) =>
              Effect.all([
                Ref.set(promptRpcSucceeded, true),
                Ref.set(promptResultRef, promptResult),
              ]),
            ),
            Effect.tapError((error) =>
              Ref.set(
                promptFailureMessageRef,
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
              ).pipe(Effect.andThen(prepared.acp.drainEvents)),
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

        return yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (ctx.acpSessionId !== prepared.acpSessionId) {
              yield* settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                errorMessage: "Devin session changed before the turn completed.",
                settleAllPrompts: true,
              });
              yield* Ref.set(promptSettled, true);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Devin session changed before the turn completed.",
              });
            }
            // Keep prompt settlement atomic with respect to Stop and steering.
            // interruptTurn marks its target before waiting for this lock, so
            // cancellation can still win while queued ACP events are drained.
            for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
              yield* Effect.yieldNow;
            }
            yield* prepared.acp.drainEvents;
            if (ctx.interruptedTurnIds.has(prepared.turnId)) {
              yield* Ref.set(promptSettled, true);
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }

            if (
              ctx.promptsInFlight <= 0 ||
              ctx.activeTurnId !== prepared.turnId ||
              ctx.session.activeTurnId !== prepared.turnId
            ) {
              yield* Ref.set(promptSettled, true);
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }

            appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);

            const usage = result.usage ?? ctx.lastAcpUsage;
            if (usage && isAcpUsageGreaterOrNew(ctx.lastAcpUsage, usage)) {
              ctx.lastAcpUsage = usage;
            }

            const tokenUsage = result.usage
              ? makeDevinTokenUsageSnapshot(result.usage, ctx.lastKnownTokenUsage)
              : undefined;
            if (tokenUsage && result.usage) {
              ctx.lastKnownTokenUsage = tokenUsage;
              yield* offerRuntimeEvent({
                type: "thread.token-usage.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: { usage: tokenUsage },
              });
            }

            if (usage) {
              const deltaTotals = devinUsageDeltaTotals(usage, ctx.lastWrittenAcpUsage);
              const totalDeltaTokens =
                deltaTotals.uncachedInputTokens +
                deltaTotals.cachedInputTokens +
                deltaTotals.cacheCreationTokens +
                deltaTotals.outputTokens;

              if (totalDeltaTokens > 0) {
                ctx.lastWrittenAcpUsage = usage;
                const observedAt = yield* nowIso;
                const usageModel = prepared.displayModel ?? ctx.session.model ?? "adaptive";
                yield* writeDevinUsageTranscriptLine(devinSettings, {
                  timestamp: observedAt,
                  sessionId: ctx.acpSessionId,
                  turnId: prepared.turnId,
                  model: usageModel,
                  totals: deltaTotals,
                  reportedCostUsd: null,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                );
              }
            }

            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: prepared.turnId,
              updatedAt: yield* nowIso,
              ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
            };
            const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
            ctx.promptsInFlight = remainingPrompts;

            // Only the last remaining prompt settles the turn. A steer-
            // superseded prompt resolving while another is in flight or
            // pending must leave the merged turn running.
            if (
              remainingPrompts === 0 &&
              ctx.activeTurnId === prepared.turnId &&
              ctx.session.activeTurnId === prepared.turnId
            ) {
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }
              const completedAt = yield* nowIso;
              const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
              ctx.activeTurnId = undefined;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt: completedAt,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const completedStopReason = completedStopReasonFromPromptResponse(result);
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: completedStopReason,
                },
              });
              ctx.interruptedTurnIds.delete(prepared.turnId);
              yield* Ref.set(promptSettled, true);
            } else if (remainingPrompts > 0) {
              yield* Ref.set(promptSettled, true);
            }

            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (yield* Ref.get(promptSettled)) {
              return;
            }

            if (yield* Ref.get(promptRpcSucceeded)) {
              const promptResult = yield* Ref.get(promptResultRef);
              if (promptResult === undefined) {
                return;
              }
              yield* withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const ctx = yield* requireSession(input.threadId);
                  if (ctx.acpSessionId !== prepared.acpSessionId) {
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        errorMessage: "Devin session changed before the turn completed.",
                        settleAllPrompts: true,
                      },
                    );
                    return;
                  }
                  if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                    return;
                  }
                  if (
                    ctx.promptsInFlight <= 0 ||
                    ctx.activeTurnId !== prepared.turnId ||
                    ctx.session.activeTurnId !== prepared.turnId
                  ) {
                    return;
                  }
                  appendPromptResultToTurn(
                    ctx,
                    prepared.turnId,
                    prepared.promptParts,
                    promptResult,
                  );
                  yield* settlePromptInFlight(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    {
                      completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                    },
                  );
                }),
              );
              return;
            }

            const errorMessage = yield* Ref.get(promptFailureMessageRef);
            yield* withThreadLock(
              input.threadId,
              settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                errorMessage: errorMessage ?? "Devin prompt request failed.",
              }),
            );
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    });

  const interruptTurn: DevinAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const observed = yield* Effect.sync(() => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return {
            _tag: "Proceed" as const,
            acpSessionId: undefined,
            interruptedTurnId: turnId,
          };
        }
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
          return { _tag: "Ignore" as const };
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        if (interruptedTurnId !== undefined) {
          ctx.interruptedTurnIds.add(interruptedTurnId);
        }
        return {
          _tag: "Proceed" as const,
          acpSessionId: ctx.acpSessionId,
          interruptedTurnId,
        };
      });
      if (observed._tag === "Ignore") {
        return;
      }

      yield* withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
            return;
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return;
          }
          if (
            observed.interruptedTurnId !== undefined &&
            activeTurnId !== undefined &&
            activeTurnId !== observed.interruptedTurnId
          ) {
            return;
          }
          const interruptedTurnId =
            observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
            ),
          );
          if (interruptedTurnId) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
            yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
              completedStopReason: "cancelled",
              settleAllPrompts: true,
            });
          } else if (
            ctx.promptsInFlight > 0 ||
            ctx.session.status === "running" ||
            ctx.session.status === "connecting"
          ) {
            const updatedAt = yield* nowIso;
            ctx.promptsInFlight = 0;
            ctx.activeTurnId = undefined;
            const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt,
            };
          }
        }),
      );
    });

  const respondToRequest: DevinAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.decision, decision);
    });

  const respondToUserInput: DevinAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* Deferred.succeed(pending.resolution, {
        _tag: "answered",
        answers,
      });
    });

  const readThread: DevinAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      return { threadId, turns: ctx.turns };
    });

  const rollbackThread: DevinAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "Devin ACP sessions do not support provider-side rollback yet.",
      });
    });

  const stopSession: DevinAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      }),
    );

  const listSessions: DevinAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const c = sessions.get(threadId);
      return c !== undefined && !c.stopped;
    });

  const stopAll: DevinAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(
      Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents,
  } satisfies DevinAdapterShape;
});
