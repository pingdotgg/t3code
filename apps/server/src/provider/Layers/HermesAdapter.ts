/**
 * HermesAdapterLive — Hermes Agent (`hermes acp`) via ACP.
 *
 * Structurally mirrors GrokAdapter.ts (session lifecycle, permission
 * handling, turn steering, liveness watchdog) with every xAI-only extension
 * stripped: no `x.ai/ask_user_question`, `x.ai/exit_plan_mode`, background
 * task tracking, or reasoning-effort metadata. Hermes speaks plain ACP, so
 * plan updates pass through the standard `session/update` "plan" field with
 * no provider-specific plan.md file extraction.
 *
 * @module HermesAdapterLive
 */

import {
  ApprovalRequestId,
  type HermesSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
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
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
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
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  HERMES_CANCEL_TIMEOUT_MS,
  resolveHermesAcpBaseModelId,
  resolveHermesAcpModeId,
  withHermesAcpAuthRetry,
} from "../acp/HermesAcpSupport.ts";
import { type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("hermes");
const HERMES_RESUME_VERSION = 1 as const;
const NANOS_PER_MILLI = 1_000_000n;
// A local stdio ACP round trip; ten silent minutes without any content or
// tool progress is long enough to distinguish a stall from legitimate work.
const DEFAULT_HERMES_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface HermesAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Override the conservative ACP turn liveness timeout in focused tests. */
  readonly turnInactivityTimeoutMs?: number;
  /** Override the 20s auth-method probe timeout in focused tests. */
  readonly authMethodProbeTimeoutMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

/**
 * ACP's `ElicitationResponse.action` distinguishes "the user answered"
 * (`accept`) from "the request was withdrawn without an answer" (`cancel`)
 * — collapsing every teardown into `accept` with empty content would tell
 * Hermes the user submitted a blank form rather than that the ask was
 * abandoned. `respondToUserInput` always means an explicit answer; session
 * stop and turn interrupt resolve as `cancelled` instead.
 */
type HermesUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

/**
 * Hermes's structured user-input mechanism is the standard ACP
 * `session/elicitation` request (form or URL mode), not a bespoke extension
 * like Grok's `x.ai/ask_user_question` or Cursor's `cursor/ask_question`.
 * `startSession` registers a `session/elicitation` handler that populates
 * this map and blocks until `respondToUserInput` resolves it.
 */
interface PendingUserInput {
  readonly resolution: Deferred.Deferred<HermesUserInputResolution>;
}

interface HermesTurnLivenessSignal {
  readonly turnId: TurnId;
}

interface HermesSessionContext {
  readonly threadId: ThreadId;
  acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Monotonic id assigned to each dispatched `session/prompt`. Only the
   * call whose seq still matches `activePromptSeq` when it settles emits the
   * turn's terminal event — an older, steered-away call stays silent. */
  promptSeq: number;
  activePromptSeq: number | undefined;
  interruptedTurnIds: Set<TurnId>;
  readonly promptLifecycle: Semaphore.Semaphore;
  readonly livenessSignals: Queue.Queue<HermesTurnLivenessSignal>;
  livenessTurnId: TurnId | undefined;
  lastTurnActivityAtNanos: bigint | undefined;
  currentModelId: string | undefined;
  stopped: boolean;
  /** The fiber of the most recently dispatched `session/prompt` RPC. A
   * mid-turn steer awaits this (bounded) after `session/cancel` instead of
   * dispatching its replacement prompt immediately: Hermes's ACP server
   * silently absorbs any `session/prompt` that arrives while the previous
   * one is still outstanding, so the adapter must not put a second one on
   * the wire until the first has actually returned. */
  activePromptFiber: Fiber.Fiber<unknown, unknown> | undefined;
  /** Text accumulated from `ContentDelta` notifications, keyed by
   * `promptSeq` rather than `turnId` — a steer's replacement prompt keeps
   * the same `turnId` as the turn it redirects, so keying by `promptSeq`
   * (unique per dispatched `session/prompt`) is what keeps a redispatch's
   * text from ever being attributed to (or clobbering) the still-settling
   * previous dispatch it replaced. Each dispatching call deletes its own
   * entry once it reads it at settlement (see the defensive check below);
   * a call that never dispatches (skipped) never writes one. */
  turnResponseText: Map<number, string>;
}

/** Bound in milliseconds on every `drainEvents` call. `drainEvents` is otherwise only bounded by the runtime's own shutdown, so a stalled event queue must never hang a settlement path. */
const DRAIN_EVENTS_TIMEOUT_MS = 2_000;
/** Bound in milliseconds on how long a mid-turn steer waits, after
 * `session/cancel`, for the previous `session/prompt` RPC to actually
 * return before dispatching its replacement. Mirrors `HERMES_CANCEL_TIMEOUT_MS`
 * (`HermesAcpSupport.ts`), the bound the session's own `cancelBehavior:
 * "wait-for-prompt"` runtime uses internally for the exact same wait —
 * this is a defensive second bound on top of it, not a separate budget.
 * See the steering branch in `sendTurn`. */
const STEER_PREVIOUS_PROMPT_AWAIT_TIMEOUT_MS = HERMES_CANCEL_TIMEOUT_MS;
/** Hermes's two known queue-absorption replies: the text it sends back,
 * with `stopReason: "end_turn"`, when a `session/prompt` it silently
 * queued (rather than adopted as the active turn) finally runs. Seeing
 * either one here means the invariant above was violated — dispatch
 * raced ahead of a still-running Hermes turn — and the response text must
 * never be presented to the user as a real answer. */
const HERMES_QUEUED_PROMPT_TEXT_PATTERN = /^Queued for the next turn\. \(\d+ queued\)$/;
const HERMES_REDIRECTED_PROMPT_TEXT = "Redirected the active turn with your correction.";

/** Drains queued ACP notifications before a settlement flips `ctx.activeTurnId`, bounded so a stalled queue can never hang the caller. */
function drainAcpEvents(acp: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "drainEvents">) {
  return Effect.ignore(acp.drainEvents.pipe(Effect.timeout(`${DRAIN_EVENTS_TIMEOUT_MS} millis`)));
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

/** Resolves outstanding `session/elicitation` requests as cancelled so a stopped or interrupted turn/session never leaves the ACP callback hanging. */
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
  ctx: HermesSessionContext,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHermesResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== HERMES_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Selects an ACP permission option id by `kind`, matching the real
 * `PermissionOption.kind` enum (`allow_once` | `allow_always` | `reject_once`
 * | `reject_always`) rather than guessing at a CLI-specific optionId string.
 */
export function selectHermesPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) {
    return preferredId;
  }
  if (decision === "acceptForSession") {
    const once = request.options.find((entry) => entry.kind === "allow_once");
    const onceId = once?.optionId.trim();
    if (onceId) {
      return onceId;
    }
  }
  if (decision === "decline") {
    const always = request.options.find((entry) => entry.kind === "reject_always");
    const alwaysId = always?.optionId.trim();
    if (alwaysId) {
      return alwaysId;
    }
  }
  return undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectHermesPermissionOptionId(request, "acceptForSession") ??
    selectHermesPermissionOptionId(request, "accept")
  );
}

function questionOption(
  label: string,
  description?: string | null,
): UserInputQuestion["options"][number] {
  return {
    label,
    description: description && description.trim() ? description.trim() : label,
  };
}

/**
 * Maps a Hermes `session/elicitation` request (ACP's standard structured
 * user-input mechanism) onto T3's `UserInputQuestion` shape. Handles the
 * `url` mode (a single link to open) and the `form` mode (one question per
 * schema property: string/enum, array/multi-select, and a generic fallback
 * for number/boolean/anything else).
 */
function questionsFromElicitation(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: request.elicitationId,
        header: "Open Link",
        question: `${request.message}\n${request.url}`,
        options: [],
        multiSelect: false,
      },
    ];
  }

  const properties = request.requestedSchema.properties ?? {};
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return [
      {
        id: "response",
        header: request.requestedSchema.title ?? "Response",
        question: request.message,
        options: [],
        multiSelect: false,
      },
    ];
  }

  return entries.map(([id, property], index) => {
    const header = property.title ?? id;
    const question = property.description ?? request.message;
    if (property.type === "string") {
      const enumOptions =
        property.oneOf?.map((option) => questionOption(option.const, option.title)) ??
        property.enum?.map((value) => questionOption(value)) ??
        [];
      return { id, header, question, options: enumOptions, multiSelect: false };
    }
    if (property.type === "array") {
      const enumOptions =
        "anyOf" in property.items
          ? property.items.anyOf.map((option) => questionOption(option.const, option.title))
          : property.items.enum.map((value) => questionOption(value));
      return { id, header, question, options: enumOptions, multiSelect: true };
    }
    return {
      id: id || `field-${index}`,
      header,
      question: property.description ?? `${request.message} (${property.type})`,
      options: [],
      multiSelect: false,
    };
  });
}

function toElicitationContentValue(
  value: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length === value.length ? strings : undefined;
  }
  if (isRecord(value) && "value" in value) {
    return toElicitationContentValue(value.value);
  }
  return undefined;
}

/** Converts T3's flat user-input answers into the elicitation response's typed content record. */
function toElicitationContent(
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answers)) {
    const converted = toElicitationContentValue(value);
    if (converted !== undefined) {
      content[key] = converted;
    }
  }
  return content;
}

export function makeHermesAdapter(
  hermesSettings: HermesSettings,
  options?: HermesAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("hermes");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, HermesSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const requestedTurnInactivityTimeoutMs = options?.turnInactivityTimeoutMs;
    const turnInactivityTimeoutMs =
      typeof requestedTurnInactivityTimeoutMs === "number" &&
      Number.isFinite(requestedTurnInactivityTimeoutMs)
        ? Math.max(1, Math.floor(requestedTurnInactivityTimeoutMs))
        : DEFAULT_HERMES_TURN_INACTIVITY_TIMEOUT_MS;
    const turnInactivityTimeoutNanos = BigInt(turnInactivityTimeoutMs) * NANOS_PER_MILLI;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Hermes runtime identifier.",
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
              detail: "Failed to process Hermes ACP callback.",
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

    const signalTurnLiveness = (ctx: HermesSessionContext, turnId: TurnId) =>
      Queue.offer(ctx.livenessSignals, { turnId }).pipe(Effect.asVoid);

    const beginTurnLiveness = (ctx: HermesSessionContext, turnId: TurnId) =>
      Effect.sync(() => {
        ctx.livenessTurnId = turnId;
        ctx.lastTurnActivityAtNanos = undefined;
      });

    const clearTurnLiveness = (ctx: HermesSessionContext) => {
      const turnId = ctx.livenessTurnId;
      ctx.livenessTurnId = undefined;
      ctx.lastTurnActivityAtNanos = undefined;
      return turnId === undefined ? Effect.void : signalTurnLiveness(ctx, turnId);
    };

    const recordTurnActivity = Effect.fn("HermesAdapter.recordTurnActivity")(function* (
      ctx: HermesSessionContext,
      turnId: TurnId,
      event: Extract<
        AcpSessionRuntime.AcpSessionRuntimeEvent,
        {
          _tag:
            | "AssistantItemStarted"
            | "AssistantItemCompleted"
            | "PlanUpdated"
            | "ToolCallUpdated"
            | "ContentDelta";
        }
      >,
    ) {
      if (
        ctx.livenessTurnId !== turnId ||
        (event._tag === "ContentDelta" && event.text.length === 0)
      ) {
        return;
      }
      const activityAtNanos = yield* Clock.monotonicTimeNanos;
      if (ctx.livenessTurnId !== turnId || ctx.interruptedTurnIds.has(turnId)) {
        return;
      }
      ctx.lastTurnActivityAtNanos = activityAtNanos;
      yield* signalTurnLiveness(ctx, turnId);
    });

    const hasLivenessPause = (ctx: HermesSessionContext) => ctx.pendingApprovals.size > 0;

    const resumeSessionTurnLiveness = Effect.fn("HermesAdapter.resumeSessionTurnLiveness")(
      function* (threadId: ThreadId, turnId: TurnId | undefined) {
        const ctx = sessions.get(threadId);
        if (!ctx || turnId === undefined || ctx.livenessTurnId !== turnId) {
          return;
        }
        ctx.lastTurnActivityAtNanos = yield* Clock.monotonicTimeNanos;
        yield* signalTurnLiveness(ctx, turnId);
      },
    );

    const signalSessionTurnLiveness = (threadId: ThreadId, turnId: TurnId | undefined) => {
      const ctx = sessions.get(threadId);
      return ctx && turnId !== undefined ? signalTurnLiveness(ctx, turnId) : Effect.void;
    };

    const isLiveTurn = (ctx: HermesSessionContext, turnId: TurnId) =>
      ctx.activeTurnId === turnId &&
      ctx.session.activeTurnId === turnId &&
      (ctx.session.status === "running" || ctx.session.status === "connecting");

    const settleStalledTurn = Effect.fn("HermesAdapter.settleStalledTurn")(function* (
      ctx: HermesSessionContext,
      turnId: TurnId,
    ) {
      return yield* withThreadLock(
        ctx.threadId,
        Effect.gen(function* () {
          const liveCtx = sessions.get(ctx.threadId);
          if (
            liveCtx !== ctx ||
            ctx.stopped ||
            !isLiveTurn(ctx, turnId) ||
            ctx.interruptedTurnIds.has(turnId) ||
            hasLivenessPause(ctx)
          ) {
            return;
          }
          const lastActivityAtNanos = ctx.lastTurnActivityAtNanos;
          if (lastActivityAtNanos === undefined) {
            return;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          if (
            ctx.interruptedTurnIds.has(turnId) ||
            !isLiveTurn(ctx, turnId) ||
            hasLivenessPause(ctx) ||
            nowNanos - lastActivityAtNanos < turnInactivityTimeoutNanos
          ) {
            return;
          }
          ctx.interruptedTurnIds.add(turnId);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/cancel", error),
              ),
            ),
          );
          // settleTurnAsInterrupted drains before touching ctx.activeTurnId.
          yield* settleTurnAsInterrupted(
            ctx,
            turnId,
            `Hermes ACP turn stalled without content or tool progress for ${turnInactivityTimeoutMs}ms.`,
          );
        }),
      );
    });

    const runTurnLivenessWatchdog = Effect.fn("HermesAdapter.runTurnLivenessWatchdog")(
      function* (ctx: HermesSessionContext) {
        while (true) {
          if (ctx.stopped) {
            return;
          }
          const turnId = ctx.livenessTurnId;
          if (
            turnId === undefined ||
            ctx.interruptedTurnIds.has(turnId) ||
            !isLiveTurn(ctx, turnId) ||
            hasLivenessPause(ctx)
          ) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }
          const lastActivityAtNanos = ctx.lastTurnActivityAtNanos;
          if (lastActivityAtNanos === undefined) {
            yield* Queue.take(ctx.livenessSignals);
            continue;
          }
          const nowNanos = yield* Clock.monotonicTimeNanos;
          const remainingNanos = turnInactivityTimeoutNanos - (nowNanos - lastActivityAtNanos);
          if (remainingNanos <= 0n) {
            yield* settleStalledTurn(ctx, turnId);
            continue;
          }
          const wakeReason = yield* Effect.raceFirst(
            Effect.sleep(Duration.nanos(remainingNanos)).pipe(Effect.as("timeout" as const)),
            Queue.take(ctx.livenessSignals).pipe(Effect.as("activity" as const)),
          );
          if (wakeReason === "timeout") {
            yield* settleStalledTurn(ctx, turnId);
          }
        }
      },
      Effect.catch(() => Effect.void),
    );

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
          Effect.logWarning("Failed to write native Hermes notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: HermesSessionContext,
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
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<HermesSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: HermesSessionContext) =>
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
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /** Ends the active turn as interrupted, guarded by whether `turnId` is still live. */
    const settleTurnAsInterrupted = (
      ctx: HermesSessionContext,
      turnId: TurnId,
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        if (!isLiveTurn(ctx, turnId)) {
          return;
        }
        // Drain any session/update notifications already queued before this
        // settlement flips ctx.activeTurnId — otherwise a trailing delta
        // from the just-cancelled prompt gets attributed to whatever turn
        // starts next. Covers both callers: the stall watchdog and the
        // user-driven interruptTurn.
        yield* drainAcpEvents(ctx.acp);
        yield* clearTurnLiveness(ctx);
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.activePromptSeq = undefined;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload:
            errorMessage !== undefined
              ? { state: "failed", errorMessage }
              : { state: "cancelled", stopReason: "cancelled" },
        });
        ctx.interruptedTurnIds.delete(turnId);
      });

    const startSession: HermesAdapterShape["startSession"] = (input) =>
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
          const hermesModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionApprovedOperations = new Set<string>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseHermesResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const hermesRuntimeInput = {
            hermesSettings,
            ...(options?.environment || mcpSession?.agentDeviceEnvironment
              ? {
                  environment: McpProviderSession.withAgentDeviceEnvironment(
                    options?.environment ?? process.env,
                    mcpSession,
                  ),
                }
              : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(options?.authMethodProbeTimeoutMs !== undefined
              ? { authMethodProbeTimeoutMs: options.authMethodProbeTimeoutMs }
              : {}),
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
          };
          // withHermesAcpAuthRetry: a cached auth-method id Hermes has
          // started rejecting (its active provider changed since caching)
          // would otherwise fail every startSession opaquely for up to the
          // cache TTL. Handler registration happens inside the retry so a
          // retried attempt registers them on the fresh runtime it built,
          // not the failed first one.
          const { acp, started } = yield* withHermesAcpAuthRetry(hermesRuntimeInput, (acp) =>
            Effect.gen(function* () {
              yield* acp.handleRequestPermission((params) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, "session/request_permission", params);
                    const permissionRequest = parsePermissionRequest(params);
                    const { kind, title, rawInput, locations } = params.toolCall;
                    const approvalKey =
                      Object.keys(rawInput ?? {}).length > 0
                        ? stableStringify({ kind, title, input: rawInput, locations })
                        : undefined;
                    const alreadyApproved =
                      approvalKey !== undefined && sessionApprovedOperations.has(approvalKey);
                    if (input.runtimeMode === "full-access" || alreadyApproved) {
                      const autoApprovedOptionId =
                        input.runtimeMode === "full-access"
                          ? selectAutoApprovedPermissionOption(params)
                          : selectHermesPermissionOptionId(params, "accept");
                      if (autoApprovedOptionId !== undefined) {
                        return {
                          outcome: { outcome: "selected" as const, optionId: autoApprovedOptionId },
                        };
                      }
                    }
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const decision = yield* Deferred.make<ProviderApprovalDecision>();
                    const ctx = sessions.get(input.threadId);
                    const turnId = ctx?.activeTurnId;
                    pendingApprovals.set(requestId, { decision });
                    yield* signalSessionTurnLiveness(input.threadId, turnId);
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
                    yield* resumeSessionTurnLiveness(input.threadId, turnId);
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
                      resolved === "cancel"
                        ? undefined
                        : selectHermesPermissionOptionId(params, resolved);
                    if (
                      resolved === "acceptForSession" &&
                      selectedOptionId &&
                      approvalKey !== undefined
                    ) {
                      sessionApprovedOperations.add(approvalKey);
                    }
                    return {
                      outcome: selectedOptionId
                        ? { outcome: "selected" as const, optionId: selectedOptionId }
                        : ({ outcome: "cancelled" } as const),
                    };
                  }),
                ),
              );
              yield* acp.handleElicitation((params) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, "session/elicitation", params);
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const resolution = yield* Deferred.make<HermesUserInputResolution>();
                    const ctx = sessions.get(input.threadId);
                    const turnId = ctx?.activeTurnId;
                    pendingUserInputs.set(requestId, { resolution });
                    yield* signalSessionTurnLiveness(input.threadId, turnId);
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: { questions: questionsFromElicitation(params) },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/elicitation",
                        payload: params,
                      },
                    });
                    const resolved = yield* Deferred.await(resolution);
                    pendingUserInputs.delete(requestId);
                    yield* resumeSessionTurnLiveness(input.threadId, turnId);
                    yield* offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolved._tag === "answered" ? resolved.answers : {} },
                    });
                    if (resolved._tag === "cancelled") {
                      return { action: { action: "cancel" as const } };
                    }
                    return {
                      action: {
                        action: "accept" as const,
                        content: toElicitationContent(resolved.answers),
                      },
                    };
                  }),
                ),
              );
              const started = yield* acp.start();
              return { acp, started };
            }),
          ).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const modeId = resolveHermesAcpModeId(input.runtimeMode);
          yield* acp.setMode(modeId).pipe(
            Effect.ignore, // Hermes may not advertise a matching mode id; fall back silently.
          );

          const requestedStartModelId = hermesModelSelection?.model
            ? resolveHermesAcpBaseModelId(hermesModelSelection.model)
            : undefined;
          const currentStartModelId = currentHermesModelIdFromSessionSetup(
            started.sessionSetupResult,
          );
          const boundModelId = yield* applyHermesAcpModelSelection({
            runtime: acp,
            currentModelId: currentStartModelId,
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: resolveHermesAcpBaseModelId(boundModelId) } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: HERMES_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: HermesSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptSeq: 0,
            activePromptSeq: undefined,
            interruptedTurnIds: new Set(),
            promptLifecycle: yield* Semaphore.make(1),
            livenessSignals: yield* Queue.sliding<HermesTurnLivenessSignal>(1),
            livenessTurnId: undefined,
            lastTurnActivityAtNanos: undefined,
            currentModelId: boundModelId,
            stopped: false,
            activePromptFiber: undefined,
            turnResponseText: new Map(),
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

                const notificationTurnId = ctx.activeTurnId;
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                if (
                  event._tag === "AssistantItemStarted" ||
                  event._tag === "AssistantItemCompleted" ||
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* recordTurnActivity(ctx, notificationTurnId, event);
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
                    // Accumulated so sendTurn's settlement can inspect the
                    // full text of THIS dispatch once the prompt RPC
                    // returns (see the queue-absorption check below).
                    // Keyed by activePromptSeq, not notificationTurnId — a
                    // steer's redispatch shares the previous dispatch's
                    // turnId, so promptSeq is what keeps this delta from
                    // ever landing on the wrong dispatch's accumulator.
                    if (ctx.activePromptSeq !== undefined) {
                      ctx.turnResponseText.set(
                        ctx.activePromptSeq,
                        (ctx.turnResponseText.get(ctx.activePromptSeq) ?? "") + event.text,
                      );
                    }
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
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Hermes runtime notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          yield* runTurnLivenessWatchdog(ctx).pipe(Effect.forkIn(ctx.scope), Effect.asVoid);
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
            payload: { state: "ready", reason: "Hermes ACP session ready" },
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

    const sendTurn: HermesAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const steering = ctx.activeTurnId !== undefined;
            const turnId = ctx.activeTurnId ?? TurnId.make(yield* randomUUIDv4);

            // Every mutation of ctx (seq counters, activeTurnId, session
            // status) is deferred until after the model-selection check
            // below succeeds. A steer whose session/set_model fails must
            // never touch the still-running original turn's state — no
            // seq bump to roll back, no activeTurnId/status flip to undo.
            const turnModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const requestedTurnModelId = turnModelSelection?.model
              ? resolveHermesAcpBaseModelId(turnModelSelection.model)
              : undefined;

            const text = input.input?.trim();
            const imagePromptParts = yield* Effect.forEach(
              (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
              (attachment) =>
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

            const modelSelectionResult = yield* Effect.result(
              applyHermesAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              }),
            );
            if (Result.isFailure(modelSelectionResult)) {
              if (steering) {
                // Hermes rejects session/set_model mid-turn. Nothing about
                // turn A was ever mutated (this branch runs before any
                // state write), so there is nothing to roll back: no
                // terminal event for A, activeTurnId/session status
                // untouched, A keeps streaming and completes exactly once
                // on its own. Report the failure as a non-terminal warning
                // the UI can surface, and drop the steer.
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    message: `Failed to switch model mid-turn: ${modelSelectionResult.failure.message}`,
                  },
                });
                return {
                  _tag: "failed" as const,
                  response: {
                    threadId: input.threadId,
                    turnId,
                    ...(ctx.session.resumeCursor !== undefined
                      ? { resumeCursor: ctx.session.resumeCursor }
                      : {}),
                  },
                };
              }
              // No turn was active, so nothing has been mutated yet either:
              // settle with a fresh failed turn.completed.
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state: "failed", errorMessage: modelSelectionResult.failure.message },
              });
              return {
                _tag: "failed" as const,
                response: {
                  threadId: input.threadId,
                  turnId,
                  ...(ctx.session.resumeCursor !== undefined
                    ? { resumeCursor: ctx.session.resumeCursor }
                    : {}),
                },
              };
            }
            const currentModelId = modelSelectionResult.success;
            ctx.currentModelId = currentModelId;
            const displayModel = currentModelId
              ? resolveHermesAcpBaseModelId(currentModelId)
              : undefined;
            const runtimeInstructions = buildRuntimeInstructions({
              harness: "Hermes",
              model: displayModel,
            });

            // Every state mutation is deferred to here, now that the model
            // switch (if any) is known to have succeeded.
            ctx.promptSeq += 1;
            const seq = ctx.promptSeq;
            ctx.activePromptSeq = seq;
            ctx.activeTurnId = turnId;

            if (!steering) {
              ctx.lastPlanFingerprint = undefined;
              yield* beginTurnLiveness(ctx, turnId);
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: displayModel ? { model: displayModel } : {},
              });
            }
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(displayModel ? { model: displayModel } : {}),
            };

            return {
              _tag: "prepared" as const,
              acp: ctx.acp,
              acpSessionId: ctx.acpSessionId,
              displayModel,
              promptParts,
              runtimeInstructions,
              turnId,
              seq,
              steering,
              promptLifecycle: ctx.promptLifecycle,
            };
          }),
        );

        if (prepared._tag === "failed") {
          return prepared.response;
        }

        // Dispatching the prompt (and, when steering, the cancel that must
        // precede it) is serialized through promptLifecycle rather than the
        // thread lock: the thread lock is released before session/prompt
        // ever reaches the wire, so two rapid steers could otherwise both
        // decide "cancel the current prompt" before either had actually
        // dispatched anything for the other to cancel, letting the middle
        // prompt run to completion unobserved. Holding this permit until
        // the replacement prompt's RPC fiber is registered (confirmed via
        // the `dispatched` Deferred) guarantees a later steer's cancel
        // targets this prompt.
        const promptStart = yield* prepared.promptLifecycle.withPermit(
          Effect.gen(function* () {
            const liveCtx = sessions.get(input.threadId);
            if (
              !liveCtx ||
              liveCtx.acpSessionId !== prepared.acpSessionId ||
              liveCtx.activePromptSeq !== prepared.seq
            ) {
              return { _tag: "skipped" as const };
            }
            // T3's own "steer" affordance (settings.followUpBehavior ===
            // "steer", wired through ChatView.tsx onSend around line 7512
            // and the queuedMessageActionsRef.steer() handler around line
            // 8225) never issues thread.turn.interrupt / interruptTurn: it
            // calls startThreadTurn directly while phase === "running",
            // landing here as a bare mid-turn sendTurn with no preceding
            // cancel from the client. (Contrast the "queue" behaviour at
            // ChatView.tsx:7512-7543, which never dispatches mid-turn at
            // all — it holds the message until the turn settles.) So this
            // adapter owns the cancel-then-redispatch sequence itself, and
            // per the Hermes bug this fixes, it must never let the
            // replacement session/prompt reach the wire before Hermes has
            // actually returned the previous one — Hermes's ACP server
            // silently queues (rather than adopts) any session/prompt that
            // arrives while the last one is still outstanding, regardless
            // of an intervening session/cancel.
            if (prepared.steering) {
              // Settle pending approvals/user-inputs before cancel: the
              // session's runtime uses cancelBehavior: "wait-for-prompt"
              // (HermesAcpSupport.ts), so cancel() below blocks on turn
              // A's real prompt() response — and that response can only
              // arrive once a local permission/elicitation callback Hermes
              // is waiting on is unblocked. cancel() plays no part in
              // resolving those; only this does.
              yield* settlePendingApprovalsAsCancelled(liveCtx.pendingApprovals);
              yield* settlePendingUserInputsAsCancelled(liveCtx.pendingUserInputs);
              if (liveCtx.activePromptSeq !== prepared.seq) {
                // A newer steer won the permit race while this one was
                // settling turn A's pending requests; it owns the
                // replacement dispatch.
                return { _tag: "skipped" as const };
              }
              // session/cancel first, same natural order as any other
              // provider. The session's runtime is configured with
              // cancelBehavior: "wait-for-prompt" (HermesAcpSupport.ts's
              // HERMES_CANCEL_TIMEOUT_MS) specifically because Hermes's
              // ACP server does not reliably stop processing a prompt on
              // cancel: the runtime's default "interrupt" behavior would
              // give up locally and synthesize an instant `cancelled`
              // result without ever observing Hermes's real response —
              // silently reintroducing the absorption bug this fix exists
              // to close. With "wait-for-prompt", this call itself blocks
              // until Hermes's real response for the previous prompt
              // arrives, bounded by the runtime's own internal
              // HERMES_CANCEL_TIMEOUT_MS — on that internal timeout the
              // runtime retires the whole session (kills the process) and
              // cancel() fails, which is deliberately NOT ignored below:
              // proceeding to dispatch into a session that may have just
              // been retired is exactly the "still active as far as
              // Hermes is concerned" risk this fix exists to close, so any
              // cancel() failure (that timeout, or a genuine
              // session/cancel transport error) drops the steer instead.
              const cancelResult = yield* liveCtx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/cancel", error),
                ),
                Effect.result,
              );
              if (liveCtx.activePromptSeq !== prepared.seq) {
                // A newer steer won the permit race while this one was
                // cancelling; it owns the replacement dispatch.
                return { _tag: "skipped" as const };
              }
              if (Result.isFailure(cancelResult)) {
                yield* offerRuntimeEvent({
                  type: "runtime.warning",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    message: `Timed out after ${STEER_PREVIOUS_PROMPT_AWAIT_TIMEOUT_MS}ms waiting for the previous prompt to finish cancelling (${cancelResult.failure.message}); dropping this steer.`,
                  },
                });
                return { _tag: "skipped" as const };
              }
              // Defensive second bound: cancel() above should already
              // have waited for turn A's own dispatched fiber to settle
              // (its internal wait-for-prompt race shares
              // HERMES_CANCEL_TIMEOUT_MS), but this confirms it directly
              // — this check, not a trust in cancel()'s own internal
              // wiring, is what actually gates the next line ever
              // reaching session/prompt.
              const previousPromptFiber = liveCtx.activePromptFiber;
              if (previousPromptFiber !== undefined) {
                const awaited = yield* Fiber.await(previousPromptFiber).pipe(
                  Effect.asVoid,
                  Effect.timeoutOption(`${STEER_PREVIOUS_PROMPT_AWAIT_TIMEOUT_MS} millis`),
                );
                if (Option.isNone(awaited)) {
                  // Turn A's prompt still hasn't returned. Dispatching now
                  // would land a second session/prompt on top of a Hermes
                  // turn that, as far as it's concerned, is still active
                  // — exactly the absorption bug this fix exists to
                  // prevent. Drop the steer instead of dispatching.
                  yield* offerRuntimeEvent({
                    type: "runtime.warning",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    payload: {
                      message: `Timed out after ${STEER_PREVIOUS_PROMPT_AWAIT_TIMEOUT_MS}ms waiting for the previous prompt to finish cancelling; dropping this steer.`,
                    },
                  });
                  return { _tag: "skipped" as const };
                }
              }
              if (liveCtx.activePromptSeq !== prepared.seq) {
                // A newer steer won the permit race while this one was
                // awaiting the previous prompt's return; it owns the
                // replacement dispatch.
                return { _tag: "skipped" as const };
              }
            }
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* liveCtx.acp
              .prompt(
                {
                  prompt: [
                    ...prepared.promptParts,
                    { type: "text", text: prepared.runtimeInstructions },
                  ],
                },
                { dispatched },
              )
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
                Effect.forkChild({ startImmediately: true }),
              );
            // Recorded so a LATER steer (once it wins the permit) can await
            // this exact RPC's return instead of racing a third
            // session/prompt onto the wire while Hermes still considers
            // this one active.
            liveCtx.activePromptFiber = fiber;
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(Effect.asVoid),
            );
            return { _tag: "started" as const, fiber };
          }),
        );

        const result =
          promptStart._tag === "started"
            ? yield* Fiber.join(promptStart.fiber).pipe(Effect.result)
            : undefined;

        return yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = sessions.get(input.threadId);
            const isWinningCall =
              ctx !== undefined &&
              ctx.acpSessionId === prepared.acpSessionId &&
              ctx.activePromptSeq === prepared.seq;
            if (!isWinningCall || result === undefined) {
              // A newer sendTurn superseded this one (or this one was never
              // dispatched at all); the newer call owns the terminal event.
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                ...(ctx?.session.resumeCursor !== undefined
                  ? { resumeCursor: ctx.session.resumeCursor }
                  : {}),
              };
            }
            const liveCtx = ctx;
            // Drain any session/update notifications already queued for this
            // prompt before the terminal event flips ctx.activeTurnId — a
            // trailing content delta that arrives after the prompt response
            // but before this drain would otherwise be attributed to the
            // NEXT turn once activeTurnId changes. Mirrors GrokAdapter's
            // unconditional post-lock drain (success and failure alike).
            yield* drainAcpEvents(liveCtx.acp);
            if (Result.isFailure(result)) {
              liveCtx.turnResponseText.delete(prepared.seq);
              yield* clearTurnLiveness(liveCtx);
              const updatedAt = yield* nowIso;
              const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
              liveCtx.activeTurnId = undefined;
              liveCtx.activePromptSeq = undefined;
              liveCtx.session = { ...readySession, status: "ready", updatedAt };
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload: { state: "failed", errorMessage: result.failure.message },
              });
              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                ...(liveCtx.session.resumeCursor !== undefined
                  ? { resumeCursor: liveCtx.session.resumeCursor }
                  : {}),
              };
            }

            appendPromptResultToTurn(
              liveCtx,
              prepared.turnId,
              prepared.promptParts,
              result.success,
            );
            // Defensive check: even with the wait above, never trust a
            // response that carries one of Hermes's own queue-absorption
            // replies — surfacing it as the turn's real answer would hide
            // the protocol violation instead of failing loudly.
            const dispatchResponseText = (liveCtx.turnResponseText.get(prepared.seq) ?? "").trim();
            liveCtx.turnResponseText.delete(prepared.seq);
            const wasAbsorbedByHermesQueue =
              result.success.stopReason === "end_turn" &&
              (HERMES_QUEUED_PROMPT_TEXT_PATTERN.test(dispatchResponseText) ||
                dispatchResponseText === HERMES_REDIRECTED_PROMPT_TEXT);
            yield* clearTurnLiveness(liveCtx);
            const completedAt = yield* nowIso;
            const { activeTurnId: _completedTurnId, ...readySession } = liveCtx.session;
            liveCtx.activeTurnId = undefined;
            liveCtx.activePromptSeq = undefined;
            liveCtx.session = {
              ...readySession,
              status: "ready",
              updatedAt: completedAt,
              ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
            };
            liveCtx.interruptedTurnIds.delete(prepared.turnId);
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: prepared.turnId,
              payload: wasAbsorbedByHermesQueue
                ? {
                    state: "failed",
                    errorMessage:
                      "Hermes absorbed the prompt into its internal queue; the adapter dispatched while a turn was running",
                  }
                : {
                    state: result.success.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.success.stopReason,
                  },
            });
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              ...(liveCtx.session.resumeCursor !== undefined
                ? { resumeCursor: liveCtx.session.resumeCursor }
                : {}),
            };
          }),
        );
      });

    const interruptTurn: HermesAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return;
        }
        const activeTurnId = ctx.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        // Outside the thread lock: with cancelBehavior "wait-for-prompt"
        // (HermesAcpSupport.ts), cancel() can now take up to
        // HERMES_CANCEL_TIMEOUT_MS to settle. Holding the thread lock for
        // that long would block every other operation on this thread —
        // including a brand-new sendTurn's own prepare phase — for the
        // same duration. Mirrors why sendTurn's own steering branch does
        // its cancel/await work outside withThreadLock too.
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (interruptedTurnId !== undefined) {
          // settleTurnAsInterrupted re-validates the turn is still live
          // (isLiveTurn) before mutating anything, so a session that
          // changed shape while cancel() was in flight above (a newer
          // turn started, the session stopped, ...) is handled safely by
          // that check rather than by holding the lock across the wait.
          yield* withThreadLock(
            threadId,
            Effect.gen(function* () {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settleTurnAsInterrupted(ctx, interruptedTurnId);
            }),
          );
        }
      });

    const respondToRequest: HermesAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
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

    const respondToUserInput: HermesAdapterShape["respondToUserInput"] = (
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
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: HermesAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: HermesAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          detail: "Hermes ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: HermesAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: HermesAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: HermesAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: HermesAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
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
    } satisfies HermesAdapterShape;
  });
}
