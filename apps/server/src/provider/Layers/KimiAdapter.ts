/**
 * KimiAdapterLive — Kimi Code CLI (`kimi acp`) via ACP.
 *
 * @module KimiAdapterLive
 */

import {
  ApprovalRequestId,
  type KimiSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyKimiAcpModelSelection,
  classifyKimiSubagentLabel,
  currentKimiModelIdFromSessionSetup,
  makeKimiAcpRuntime,
  resolveKimiAcpBaseModelId,
  resolveRequestedKimiModeId,
} from "../acp/KimiAcpSupport.ts";
import { type KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("kimi");
const KIMI_RESUME_VERSION = 1 as const;

/** Serializes diagnostic payloads when they are representable as JSON. */
function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

/** ACP elicitation responses only encode these content values; anything
 * else would abort the turn at response-encoding time. */
const isElicitationContentValue = Schema.is(EffectAcpSchema.ElicitationContentValue);

export interface KimiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`kimi`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `kimiSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<KimiSettings>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

type PendingUserInputResolution =
  | {
      readonly _tag: "answered";
      /** Answers validated as ACP-encodable elicitation content. */
      readonly answers: Record<string, EffectAcpSchema.ElicitationContentValue>;
    }
  | { readonly _tag: "cancelled" };

/** The form-mode variant of an ACP elicitation request; the URL variant
 * never reaches the user-input flow. */
type FormElicitationRequest = Extract<EffectAcpSchema.ElicitationRequest, { mode: "form" }>;

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
  /** Form schema from the registered request; answers are validated
   * against it before the entry is consumed. */
  readonly requestedSchema: FormElicitationRequest["requestedSchema"];
}

interface KimiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  currentModelId: string | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  stopped: boolean;
}

/** Cancels and consumes every outstanding permission request for a session. */
function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.entries()),
    ([requestId, pending]) =>
      Effect.gen(function* () {
        // Consume the entry while settling so a late response is rejected as
        // unknown instead of resolving an already-settled deferred.
        pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
      }),
    { discard: true },
  );
}

/** Cancels and consumes every outstanding elicitation request for a session. */
function settlePendingUserInputsAsCancelled(
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.entries()),
    ([requestId, pending]) =>
      Effect.gen(function* () {
        // Consume the entry while settling so a late response is rejected as
        // unknown instead of resolving an already-settled deferred.
        pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
      }),
    { discard: true },
  );
}

/** Narrows a non-null, non-array object to a string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes the versioned session identifier stored in Kimi resume metadata. */
function parseKimiResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== KIMI_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/** Applies requested model and interaction-mode changes to an ACP session. */
function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly model: string | undefined;
  readonly currentModelId: string | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_model" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.model !== undefined) {
      yield* applyKimiAcpModelSelection({
        runtime: input.runtime,
        currentModelId: input.currentModelId,
        requestedModelId: resolveKimiAcpBaseModelId(input.model),
        mapError: (cause) =>
          input.mapError({
            cause,
            method: "session/set_model",
          }),
      });
    }

    const requestedModeId = resolveRequestedKimiModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

/** Chooses Kimi's most permissive available option for an auto-approved request. */
function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

/**
 * Picks the optionId Kimi actually offered for a user decision, matched by
 * option kind. ACP option ids are provider-defined, so the hardcoded
 * `acpPermissionOutcome` ids are only a fallback when nothing matches.
 * acceptForSession and acceptAlways degrade to an allow_once option when no
 * allow_always is offered, so the response never selects an id Kimi never
 * sent. acceptAlways is not covered by `acpPermissionOutcome`, so its
 * hardcoded fallback is "allow-always".
 */
export function selectDecisionPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string {
  const kinds =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once"] as const)
        : (["reject_once"] as const);
  for (const kind of kinds) {
    const option = request.options.find((entry) => entry.kind === kind);
    if (typeof option?.optionId === "string" && option.optionId.trim()) {
      return option.optionId.trim();
    }
  }
  return decision === "acceptAlways" ? "allow-always" : acpPermissionOutcome(decision);
}

/** Map a single ElicitationPropertySchema entry to T3 UserInputQuestionOption values. */
function elicitationPropertyToOptions(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ label: string; value?: string; description: string }> {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => ({
        label: option.title.trim() || option.const,
        value: option.const,
        description: option.title,
      }));
    }
    if (property.enum && property.enum.length > 0) {
      return property.enum.map((value) => ({
        label: value,
        value,
        description: value,
      }));
    }
    return [];
  }
  if (property.type === "boolean") {
    return [
      { label: "True", value: "true", description: "True" },
      { label: "False", value: "false", description: "False" },
    ];
  }
  if (property.type === "array") {
    if ("enum" in property.items) {
      return property.items.enum.map((value) => ({
        label: value,
        value,
        description: value,
      }));
    }
    return property.items.anyOf.map((option) => ({
      label: option.title.trim() || option.const,
      value: option.const,
      description: option.title,
    }));
  }
  return [];
}

/** Enum-shaped allowed values for an elicitation property, mirroring how
 * `elicitationPropertyToOptions` reads the schema. Properties without
 * declared options return undefined and stay free-form. */
function allowedElicitationValues(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<string> | undefined {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => option.const);
    }
    if (property.enum && property.enum.length > 0) {
      return property.enum;
    }
    return undefined;
  }
  if (property.type === "array") {
    if ("enum" in property.items) {
      return property.items.enum;
    }
    if (property.items.anyOf.length > 0) {
      return property.items.anyOf.map((option) => option.const);
    }
  }
  return undefined;
}

/**
 * Coerce string answers to the type the elicitation schema declares for the
 * key. Clients transport option picks and custom answers as strings, so
 * "true"/"false" become booleans and numeric strings become numbers for
 * number/integer properties. Undeclared keys and non-convertible strings keep
 * their raw value; `elicitationSchemaIssue` then reports the proper error.
 */
function normalizeElicitationAnswer(
  schema: FormElicitationRequest["requestedSchema"],
  key: string,
  value: unknown,
): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const property = schema.properties?.[key];
  if (!property) {
    return value;
  }
  if (property.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (property.type === "number" || property.type === "integer") {
    const parsed = Number(value);
    if (value.trim() === "" || !Number.isFinite(parsed)) {
      return value;
    }
    if (property.type === "integer" && !Number.isInteger(parsed)) {
      return value;
    }
    return parsed;
  }
  return value;
}

/**
 * Validate answered content against the elicitation form schema. The schema
 * is enforced property-by-property: unknown keys are rejected, every declared
 * property's `type` is checked before any enum/oneOf membership, and string or
 * array constraints (enum / oneOf) apply only after the type check passes.
 * Unconstrained properties of the matching type are accepted (free-form).
 */
function elicitationSchemaIssue(
  schema: FormElicitationRequest["requestedSchema"],
  content: Record<string, EffectAcpSchema.ElicitationContentValue>,
): string | undefined {
  for (const name of schema.required ?? []) {
    if (content[name] === undefined) {
      return `Missing required answer for "${name}".`;
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(content)) {
    const property = properties[key];
    if (!property) {
      return `Answer for "${key}" is not declared by the requested schema.`;
    }
    const allowed = allowedElicitationValues(property);
    if (property.type === "array") {
      if (!Array.isArray(value)) {
        return `Answer for "${key}" must be an array of strings.`;
      }
      if (allowed && value.some((element) => !allowed.includes(element))) {
        return `Answer for "${key}" must only use: ${allowed.join(", ")}.`;
      }
      continue;
    }
    if (property.type === "string") {
      if (typeof value !== "string") {
        return `Answer for "${key}" must be a string.`;
      }
    } else if (property.type === "number") {
      if (typeof value !== "number") {
        return `Answer for "${key}" must be a number.`;
      }
    } else if (property.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `Answer for "${key}" must be an integer.`;
      }
    } else if (property.type === "boolean") {
      if (typeof value !== "boolean") {
        return `Answer for "${key}" must be a boolean.`;
      }
    } else {
      return `Answer for "${key}" has an unsupported schema type.`;
    }
    if (
      allowed &&
      property.type === "string" &&
      typeof value === "string" &&
      !allowed.includes(value)
    ) {
      return `Answer for "${key}" must be one of: ${allowed.join(", ")}.`;
    }
  }
  return undefined;
}

/**
 * Map an ACP form-mode elicitation schema into one UserInputQuestion per
 * property. Best-effort: anything we cannot translate (e.g. numeric properties
 * without a known UI surface) still becomes a question with an empty option
 * list and `allowCustomAnswer: true`, so the user can free-form type.
 */
function mapElicitationFormToQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> | undefined {
  if (request.mode !== "form") return undefined;
  const schema = request.requestedSchema;
  const properties = schema.properties ?? {};
  const questions: Array<UserInputQuestion> = [];
  for (const [propertyId, property] of Object.entries(properties)) {
    const options = elicitationPropertyToOptions(property);
    const isArray = property.type === "array";
    const hasEnum = options.length > 0;
    // Enum/oneOf properties are validated strictly on the server, so the UI
    // must not offer a free-form escape hatch; only properties without a
    // known option list allow a custom answer.
    const allowCustomAnswer = !hasEnum;
    const header = (property.title?.trim() || schema.title?.trim() || "Question").slice(0, 120);
    questions.push({
      id: propertyId,
      header,
      question:
        property.description?.trim() ||
        property.title?.trim() ||
        request.message ||
        "Please answer.",
      options: options.map((option) => ({
        label: option.label,
        description: option.description,
        ...(option.value !== undefined ? { value: option.value } : {}),
      })),
      allowCustomAnswer,
      multiSelect: isArray,
    });
  }
  return questions;
}

/** Reclassify Kimi's `Agent` / `AgentSwarm` tool calls as subagent rows. */
function makeKimiToolCallEvent(input: {
  readonly stamp: { readonly eventId: EventId; readonly createdAt: string };
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const event = makeAcpToolCallEvent({
    stamp: input.stamp,
    provider: PROVIDER,
    threadId: input.threadId,
    turnId: input.turnId,
    toolCall: input.toolCall,
    rawPayload: input.rawPayload,
  });
  if (event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  // The parsed state carries a presentation summary (e.g. Kimi's `Agent`
  // dispatch with kind `read` becomes "Read file"), so the dispatch name is
  // read back from the raw notification.
  const update = isRecord(input.rawPayload) ? input.rawPayload.update : undefined;
  const rawTitle = isRecord(update) && typeof update.title === "string" ? update.title : undefined;
  const subagentLabel = classifyKimiSubagentLabel(rawTitle);
  if (!subagentLabel) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      itemType: "collab_agent_tool_call" as const,
      title: subagentLabel,
    },
  };
}

/**
 * Builds a scoped, per-instance Kimi adapter that translates ACP sessions and
 * notifications into T3 provider operations and runtime events.
 */
export function makeKimiAdapter(kimiSettings: KimiSettings, options?: KimiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kimi");
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

    const sessions = new Map<ThreadId, KimiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Kimi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Kimi ACP extension event.",
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
      });

    const emitPlanUpdate = (
      ctx: KimiSessionContext,
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
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KimiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: KimiSessionContext) =>
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

    const startSession: KimiAdapterShape["startSession"] = (input) =>
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
          const kimiModelSelection =
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
          let ctx!: KimiSessionContext;

          const resumeSessionId = parseKimiResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the KimiSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { kimi: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveKimiSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : kimiSettings;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeKimiAcpRuntime({
            kimiSettings: effectiveKimiSettings,
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
            ...(resumeSessionId ? { resumeSessionId, resumeMethod: "resume" as const } : {}),
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
              mapExtensionFailure(
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
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
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
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: selectDecisionPermissionOptionId(params, resolved),
                          },
                  };
                }),
              ),
            );
            yield* acp.handleElicitation((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/elicitation", params);
                  if (params.mode !== "form") {
                    // URL-mode elicitation is not surfaced today; cancel so
                    // the agent can decide whether to retry with a form or
                    // fall back. `methodNotFound` was the prior behavior and
                    // it wedged the agent indefinitely.
                    return { action: { action: "cancel" as const } };
                  }
                  const questions = mapElicitationFormToQuestions(params);
                  if (!questions || questions.length === 0) {
                    return { action: { action: "cancel" as const } };
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const resolution = yield* Deferred.make<PendingUserInputResolution>();
                  pendingUserInputs.set(requestId, {
                    resolution,
                    requestedSchema: params.requestedSchema,
                  });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: [...questions] },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(resolution);
                  const answers = resolved._tag === "answered" ? resolved.answers : {};
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  if (resolved._tag === "answered") {
                    return {
                      action: {
                        action: "accept" as const,
                        content: answers,
                      },
                    };
                  }
                  return { action: { action: "cancel" as const } };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const currentModelId = currentKimiModelIdFromSessionSetup(started.sessionSetupResult);
          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            model: kimiModelSelection?.model,
            currentModelId,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: kimiModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: KIMI_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            currentModelId,
            promptsInFlight: 0,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "ConfigOptionsUpdated":
                    return;
                  case "AvailableCommandsUpdated":
                    yield* (
                      options?.onAvailableCommands?.(event.availableCommands, cwd) ?? Effect.void
                    );
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeKimiToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
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
              Effect.logError("Failed to process Kimi runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
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
            payload: { state: "ready", reason: "Kimi ACP session ready" },
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

    const sendTurn: KimiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Admission runs synchronously before any async setup so a concurrent
        // sendTurn observes this turn through `activeTurnId`, not just the
        // pre-claim `promptsInFlight` count. Without claiming the active turn
        // here, a concurrent sendTurn would compute `steeringTurnId ===
        // undefined`, allocate its own turn id, and duplicate the
        // `turn.started` event before this fiber finishes setup.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt and claim the active turn before any async step
        // so the matching decrement (in `ensuring` below) leaves the counter
        // and active-turn state coherent.
        ctx.promptsInFlight += 1;
        ctx.activeTurnId = turnId;
        if (steeringTurnId === undefined) {
          ctx.lastPlanFingerprint = undefined;
        }

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveKimiAcpBaseModelId(model);
          const nextModelId = yield* applyKimiAcpModelSelection({
            runtime: ctx.acp,
            currentModelId: ctx.currentModelId,
            requestedModelId: model === undefined ? undefined : resolvedModel,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });
          ctx.currentModelId = nextModelId;

          const requestedModeId = resolveRequestedKimiModeId({
            interactionMode: input.interactionMode,
            runtimeMode: ctx.session.runtimeMode,
            modeState: yield* ctx.acp.getModeState,
          });
          if (requestedModeId) {
            yield* ctx.acp
              .setMode(requestedModeId)
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
                ),
              );
          }

          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) {
            promptParts.push({ type: "text", text: rawPrompt });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              // Kimi ingests images only. Generic files reach the agent
              // through the path line ProviderService puts in the prompt.
              if (attachment.type !== "image") {
                continue;
              }
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
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // ACP commands parse the complete text. Extra context can turn an exact
          // command into an ordinary model prompt or change its arguments.
          const result = yield* ctx.acp
            .prompt({
              prompt: /^\/[^\s/]+(?:\s|$)/.test(rawPrompt)
                ? promptParts
                : [
                    ...promptParts,
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: "Kimi Code",
                        model: resolvedModel,
                      }),
                    },
                  ],
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          yield* ctx.acp.drainEvents;

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model: resolvedModel,
          };

          // Only the last remaining prompt settles the turn — a steer-
          // superseded prompt resolving (usually cancelled) while another is
          // in flight or pending must leave the merged turn running.
          if (ctx.promptsInFlight === 1) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: KimiAdapterShape["respondToRequest"] = (
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
        // Consume the entry before settling so a duplicate response is
        // rejected as unknown instead of no-op'ing on a settled deferred.
        ctx.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
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
        const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
        for (const [key, value] of Object.entries(answers)) {
          const normalized = normalizeElicitationAnswer(pending.requestedSchema, key, value);
          if (!isElicitationContentValue(normalized)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `Answer for "${key}" must be a string, number, boolean, or array of strings.`,
            });
          }
          content[key] = normalized;
        }
        const issue = elicitationSchemaIssue(pending.requestedSchema, content);
        if (issue) {
          // Leave the entry in place so the request stays pending and the
          // user can retry with corrected answers.
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue,
          });
        }
        // Consume the entry before settling so a duplicate response is
        // rejected as unknown instead of no-op'ing on a settled deferred.
        ctx.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers: content });
      });

    const readThread: KimiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          detail: "Kimi ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: KimiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: KimiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Kimi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compact" },
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
    } satisfies KimiAdapterShape;
  });
}
