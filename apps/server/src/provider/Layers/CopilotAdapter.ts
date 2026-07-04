/**
 * CopilotAdapterLive — GitHub Copilot CLI (`copilot --acp`) via ACP.
 *
 * @module CopilotAdapterLive
 */
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  ProviderDriverKind,
  type ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Scope,
  Schema,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { collectSessionConfigOptionValues } from "../acp/AcpRuntimeModel.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpModeChangedEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  selectCopilotPermissionForDecision,
  selectCopilotPermissionForRuntimeMode,
} from "../acp/CopilotAcpPermissions.ts";
import { makeCopilotAcpRuntime, resolveCopilotAcpModeId } from "../acp/CopilotAcpSupport.ts";
import {
  copilotFatalToolCallErrorMessage,
  detectCopilotFatalToolCallError,
  extractCopilotPlanUpdate,
  normalizeCopilotParsedSessionEvent,
  normalizeCopilotPermissionRequest,
} from "../acp/CopilotAcpRuntimeModel.ts";
import {
  hasConcreteCopilotCurrentModel,
  readCopilotMergedSettings,
} from "../acp/CopilotSettings.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_RESUME_VERSION = 1 as const;
const COPILOT_RETAINED_TEXT_PREVIEW_LENGTH = 4096;

export interface CopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CopilotRuntimeCopilotSettings = {
  readonly binaryPath: string | undefined;
};

interface CopilotRuntimeResources {
  readonly started: AcpSessionRuntimeStartResult;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly notificationFiber: Fiber.Fiber<void, never>;
}

interface CopilotRetainedTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  readonly copilotSettings: CopilotRuntimeCopilotSettings;
  session: ProviderSession;
  scope: Scope.Closeable;
  acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly fullAccessWarningKeys: Set<string>;
  readonly turns: Array<CopilotRetainedTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  inFlightTurnId: TurnId | undefined;
  cancelRequestedTurnId: TurnId | undefined;
  readonly fatalErrorByTurnId: Map<TurnId, string>;
  stopped: boolean;
}

type CopilotStartSessionInput = Parameters<CopilotAdapterShape["startSession"]>[0] & {
  readonly resumeFallback?: "create" | "fail";
};

const COPILOT_FORK_UNSUPPORTED_DETAIL =
  "This Copilot ACP agent does not support native chat forking. The visible T3 chat fork was created, but Copilot context cannot be continued safely from it.";

function stringifyCause(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  return typeof value === "string" ? value : String(value);
}

function copilotAcpExitMatch(cause: Error): RegExpMatchArray | null {
  const parts = [cause.message];
  if (isAcpTransportError(cause)) {
    parts.push(cause.detail, stringifyCause(cause.cause));
  }
  const combined = parts.filter((part) => part.trim().length > 0).join("\n");
  return combined.match(/ACP process exited(?: with code (\d+))?/i);
}

function formatCopilotStartupError(cause: Error): string {
  const exitedMatch = copilotAcpExitMatch(cause);
  if (exitedMatch) {
    const exitText = exitedMatch[1] ? `exited with code ${exitedMatch[1]}` : "exited";
    return `GitHub Copilot ACP process ${exitText} before completing startup. Update the Copilot CLI with "copilot update", restart T3 Code, then try again. If it still fails, run "copilot login" in a terminal and verify "copilot --version" reports a version with working ACP support.`;
  }
  if (isAcpTransportError(cause) && cause.detail.trim().length > 0) {
    return `GitHub Copilot ACP transport failed during startup: ${cause.detail}`;
  }
  return cause.message.trim() || "GitHub Copilot ACP process failed during startup.";
}

function hasCopilotAcpForkCapability(result: AcpSessionRuntimeStartResult): boolean {
  const forkCapability = result.initializeResult.agentCapabilities?.sessionCapabilities?.fork;
  return forkCapability !== undefined && forkCapability !== null;
}

function mapCopilotForkAcpError(threadId: ThreadId, error: EffectAcpErrors.AcpError) {
  if (isAcpRequestError(error) && error.code === -32601) {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session/fork",
      detail: COPILOT_FORK_UNSUPPORTED_DETAIL,
      cause: error,
    });
  }
  return mapAcpToAdapterError(PROVIDER, threadId, "session/fork", error);
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingApprovals.clear())));
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingUserInputs.clear())));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retainedTextPreview(text: string): {
  readonly text: string;
  readonly textLength?: number;
  readonly truncated?: true;
} {
  if (text.length <= COPILOT_RETAINED_TEXT_PREVIEW_LENGTH) {
    return { text };
  }
  return {
    text: text.slice(0, COPILOT_RETAINED_TEXT_PREVIEW_LENGTH),
    textLength: text.length,
    truncated: true,
  };
}

function retainedPromptPart(part: EffectAcpSchema.ContentBlock): unknown {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        ...retainedTextPreview(part.text),
      };
    case "image":
      return {
        type: "image",
        mimeType: part.mimeType,
        dataLength: part.data.length,
        ...(part.uri ? { uri: part.uri } : {}),
      };
    case "audio":
      return {
        type: "audio",
        mimeType: part.mimeType,
        dataLength: part.data.length,
      };
    case "resource_link":
      return {
        type: "resource_link",
        name: part.name,
        uri: part.uri,
        ...(part.title ? { title: part.title } : {}),
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.size !== undefined && part.size !== null ? { size: part.size } : {}),
      };
    case "resource":
      return {
        type: "resource",
        uri: part.resource.uri,
        ...(part.resource.mimeType ? { mimeType: part.resource.mimeType } : {}),
        ...("text" in part.resource
          ? {
              text: part.resource.text.slice(0, COPILOT_RETAINED_TEXT_PREVIEW_LENGTH),
              textLength: part.resource.text.length,
              ...(part.resource.text.length > COPILOT_RETAINED_TEXT_PREVIEW_LENGTH
                ? { truncated: true as const }
                : {}),
            }
          : {
              blobLength: part.resource.blob.length,
            }),
      };
  }
}

function retainedPromptParts(
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): ReadonlyArray<unknown> {
  return promptParts.map(retainedPromptPart);
}

function retainedPromptResult(result: EffectAcpSchema.PromptResponse): unknown {
  return {
    stopReason: result.stopReason,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.userMessageId ? { userMessageId: result.userMessageId } : {}),
  };
}

function cloneCopilotTurns(
  turns: ReadonlyArray<CopilotRetainedTurnSnapshot>,
): ReadonlyArray<CopilotRetainedTurnSnapshot> {
  return turns.map((turn) => ({
    id: turn.id,
    items: [...turn.items],
  }));
}

function parseCopilotResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== COPILOT_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function leakedFullAccessWarningKey(
  permissionRequest: ReturnType<typeof normalizeCopilotPermissionRequest>,
): string {
  return `${permissionRequest.kind}:${permissionRequest.toolCall?.itemType ?? "unknown"}`;
}

function textOrFallback(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function enumOptionsFromProperty(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<UserInputQuestion["options"][number]> {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => ({
        label: option.const,
        description: textOrFallback(option.title, option.const),
      }));
    }
    if (property.enum && property.enum.length > 0) {
      return property.enum.map((value) => ({
        label: value,
        description: value,
      }));
    }
  }

  if (property.type === "boolean") {
    return [
      { label: "true", description: "Yes" },
      { label: "false", description: "No" },
    ];
  }

  if (property.type === "array") {
    if ("anyOf" in property.items) {
      return property.items.anyOf.map((option) => ({
        label: option.const,
        description: textOrFallback(option.title, option.const),
      }));
    }
    return property.items.enum.map((value) => ({
      label: value,
      description: value,
    }));
  }

  return [{ label: "Provide answer", description: "Type the answer below." }];
}

function questionsFromElicitationRequest(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: "__url__",
        header: "Open browser",
        question: `${request.message}\n${request.url}`,
        options: [{ label: "Done", description: "Continue after completing the browser step." }],
        multiSelect: false,
      },
    ];
  }

  const properties = request.requestedSchema.properties ?? {};
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return [
      {
        id: "__confirm__",
        header: textOrFallback(request.requestedSchema.title, "Input requested"),
        question: request.message,
        options: [{ label: "Continue", description: "Submit an empty response." }],
        multiSelect: false,
      },
    ];
  }

  return entries.map(([id, property], index) => ({
    id,
    header: textOrFallback(property.title, `Question ${index + 1}`),
    question: textOrFallback(property.description, request.message),
    options: [...enumOptionsFromProperty(property)],
    multiSelect: property.type === "array",
  }));
}

function normalizeAnswerValue(value: unknown): string | ReadonlyArray<string> | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }
  return undefined;
}

function coerceElicitationContentValue(
  property: EffectAcpSchema.ElicitationPropertySchema | undefined,
  value: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  const normalized = normalizeAnswerValue(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!property) {
    return Array.isArray(normalized) ? normalized : normalized;
  }

  switch (property.type) {
    case "boolean":
      if (Array.isArray(normalized)) {
        return normalized[0] === "true";
      }
      return typeof normalized === "string"
        ? normalized.toLowerCase() === "true" || normalized.toLowerCase() === "yes"
        : undefined;
    case "integer": {
      const parsed = Number.parseInt(
        Array.isArray(normalized) ? (normalized[0] ?? "") : normalized,
      );
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "number": {
      const parsed = Number(Array.isArray(normalized) ? (normalized[0] ?? "") : normalized);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "array":
      return typeof normalized === "string" ? [normalized] : normalized;
    case "string":
      return typeof normalized === "string" ? normalized : normalized[0];
    default:
      return normalized;
  }
}

function buildElicitationResponseAction(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse["action"] {
  if (Object.keys(answers).length === 0) {
    return { action: "cancel" };
  }
  if (request.mode === "url") {
    return { action: "accept", content: {} };
  }

  const properties = request.requestedSchema.properties ?? {};
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [id, property] of Object.entries(properties)) {
    const value = coerceElicitationContentValue(property, answers[id]);
    if (value !== undefined) {
      content[id] = value;
    }
  }
  return { action: "accept", content };
}

function unsupportedClientToolError(toolName: string): EffectAcpErrors.AcpRequestError {
  return EffectAcpErrors.AcpRequestError.internalError(
    `${toolName} is not supported by this Copilot ACP client.`,
    { method: toolName },
  );
}

function resolveEffectiveCopilotModel(input: {
  readonly configuredModel: string | undefined;
  readonly selectedModel: string | undefined;
}): string | undefined {
  const selectedModel = input.selectedModel?.trim();
  if (selectedModel && selectedModel !== "auto") {
    return selectedModel;
  }
  return hasConcreteCopilotCurrentModel(input.configuredModel) ? input.configuredModel : undefined;
}

function clearTurnState(ctx: CopilotSessionContext, turnId: TurnId): void {
  const sessionHasTurn = ctx.session.activeTurnId === turnId;
  if (ctx.activeTurnId === turnId) {
    ctx.activeTurnId = undefined;
  }
  if (ctx.inFlightTurnId === turnId) {
    ctx.inFlightTurnId = undefined;
  }
  if (ctx.cancelRequestedTurnId === turnId) {
    ctx.cancelRequestedTurnId = undefined;
  }
  if (sessionHasTurn) {
    ctx.session = {
      ...ctx.session,
      activeTurnId: undefined,
      updatedAt: new Date().toISOString(),
    };
  }
}

export function makeCopilotAdapter(options?: CopilotAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CopilotSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.sync(() => EventId.make(crypto.randomUUID()));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
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

    const deleteThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        if (!current.has(threadId)) {
          return Effect.succeed([undefined, current] as const);
        }
        const next = new Map(current);
        next.delete(threadId);
        return Effect.succeed([undefined, next] as const);
      });

    const clearThreadSemaphores = SynchronizedRef.modifyEffect(threadLocksRef, () =>
      Effect.succeed([undefined, new Map<string, Semaphore.Semaphore>()] as const),
    );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
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

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CopilotSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const toProcessError = (threadId: ThreadId, cause: Error) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: formatCopilotStartupError(cause),
        cause,
      });

    const closeRuntimeResources = (runtime: {
      readonly notificationFiber: Fiber.Fiber<void, never> | undefined;
      readonly scope: Scope.Closeable;
    }) =>
      Effect.gen(function* () {
        const notificationFiber = runtime.notificationFiber;
        if (notificationFiber) {
          yield* Fiber.interrupt(notificationFiber);
        }
        yield* Effect.ignore(Scope.close(runtime.scope, Exit.void));
      });

    const closeRuntimeInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        const notificationFiber = ctx.notificationFiber;
        ctx.notificationFiber = undefined;
        yield* closeRuntimeResources({
          notificationFiber,
          scope: ctx.scope,
        });
      });

    const stopSessionInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.inFlightTurnId = undefined;
        ctx.cancelRequestedTurnId = undefined;
        ctx.activeTurnId = undefined;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        ctx.turns.length = 0;
        yield* closeRuntimeInternal(ctx);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const openRuntime = (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly copilotSettings: CopilotRuntimeCopilotSettings;
      readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
      readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
      readonly fullAccessWarningKeys: Set<string>;
      readonly getCurrentTurnId: () => TurnId | undefined;
      readonly onFatalCopilotError?: (turnId: TurnId, message: string) => void;
      readonly resumeSessionId?: string;
      readonly resumeFallback?: "create" | "fail";
    }) =>
      Effect.gen(function* () {
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const acpNativeLoggers = makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        });

        const acp = yield* makeCopilotAcpRuntime({
          copilotSettings: input.copilotSettings.binaryPath
            ? { binaryPath: input.copilotSettings.binaryPath }
            : undefined,
          childProcessSpawner,
          cwd: input.cwd,
          runtimeMode: input.runtimeMode,
          ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          ...(input.resumeFallback ? { resumeFallback: input.resumeFallback } : {}),
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((cause) => toProcessError(input.threadId, cause)),
        );

        const started = yield* Effect.gen(function* () {
          yield* acp.handleRequestPermission((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/request_permission", params);
              const permissionRequest = normalizeCopilotPermissionRequest(params);
              const autoApproval = selectCopilotPermissionForRuntimeMode({
                runtimeMode: input.runtimeMode,
                params,
                permissionRequest,
              });

              if (input.runtimeMode === "full-access") {
                const warningKey = leakedFullAccessWarningKey(permissionRequest);
                if (!input.fullAccessWarningKeys.has(warningKey)) {
                  input.fullAccessWarningKeys.add(warningKey);
                  yield* offerRuntimeEvent({
                    type: "runtime.warning",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: input.getCurrentTurnId(),
                    payload: {
                      message: "Copilot requested permission despite full-access runtime mode.",
                      detail: {
                        requestKind: permissionRequest.kind,
                        requestDetail: permissionRequest.detail ?? null,
                      },
                    },
                  });
                }
              }

              if (autoApproval._tag === "select") {
                return {
                  outcome: {
                    outcome: "selected" as const,
                    optionId: autoApproval.optionId,
                  },
                };
              }
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              input.pendingApprovals.set(requestId, {
                decision,
                kind: permissionRequest.kind,
              });
              yield* offerRuntimeEvent(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: input.getCurrentTurnId(),
                  requestId: runtimeRequestId,
                  permissionRequest,
                  detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );
              const resolved = yield* Deferred.await(decision);
              input.pendingApprovals.delete(requestId);
              yield* offerRuntimeEvent(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeEventStamp(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: input.getCurrentTurnId(),
                  requestId: runtimeRequestId,
                  permissionRequest,
                  decision: resolved,
                }),
              );
              const selection = selectCopilotPermissionForDecision({
                params,
                decision: resolved,
              });
              return {
                outcome:
                  selection._tag === "select"
                    ? {
                        outcome: "selected" as const,
                        optionId: selection.optionId,
                      }
                    : ({ outcome: "cancelled" } as const),
              };
            }),
          );
          yield* acp.handleElicitation((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "session/elicitation", params);
              const requestId = ApprovalRequestId.make(crypto.randomUUID());
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const answers = yield* Deferred.make<ProviderUserInputAnswers>();
              input.pendingUserInputs.set(requestId, { answers });
              yield* offerRuntimeEvent({
                type: "user-input.requested",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.getCurrentTurnId(),
                requestId: runtimeRequestId,
                payload: { questions: questionsFromElicitationRequest(params) },
                raw: {
                  source: "acp.jsonrpc",
                  method: "session/elicitation",
                  payload: params,
                },
              });
              const resolved = yield* Deferred.await(answers);
              input.pendingUserInputs.delete(requestId);
              yield* offerRuntimeEvent({
                type: "user-input.resolved",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: input.getCurrentTurnId(),
                requestId: runtimeRequestId,
                payload: { answers: resolved },
              });
              return {
                action: buildElicitationResponseAction(params, resolved),
              };
            }),
          );
          yield* acp.handleReadTextFile((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "fs/read_text_file", params);
              return yield* unsupportedClientToolError("fs/read_text_file");
            }),
          );
          yield* acp.handleWriteTextFile((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "fs/write_text_file", {
                ...params,
                contentLength: params.content.length,
                content: undefined,
              });
              return yield* unsupportedClientToolError("fs/write_text_file");
            }),
          );
          yield* acp.handleCreateTerminal((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "terminal/create", params);
              return yield* unsupportedClientToolError("terminal/create");
            }),
          );
          yield* acp.handleTerminalOutput((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "terminal/output", params);
              return yield* unsupportedClientToolError("terminal/output");
            }),
          );
          yield* acp.handleTerminalWaitForExit((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "terminal/wait_for_exit", params);
              return yield* unsupportedClientToolError("terminal/wait_for_exit");
            }),
          );
          yield* acp.handleTerminalKill((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "terminal/kill", params);
              return yield* unsupportedClientToolError("terminal/kill");
            }),
          );
          yield* acp.handleTerminalRelease((params) =>
            Effect.gen(function* () {
              yield* logNative(input.threadId, "terminal/release", params);
              return yield* unsupportedClientToolError("terminal/release");
            }),
          );
          return yield* acp.start();
        }).pipe(
          Effect.mapError((error) => {
            if (isAcpTransportError(error) && copilotAcpExitMatch(error)) {
              return new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: formatCopilotStartupError(error),
                cause: error,
              });
            }
            return mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error);
          }),
        );
        if (input.resumeSessionId) {
          yield* acp.discardPendingEvents;
        }

        const assistantItemTurnIdByItemId = new Map<string, TurnId>();
        const notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (rawEvent) =>
            Effect.gen(function* () {
              const normalizedEvents = normalizeCopilotParsedSessionEvent(rawEvent);
              for (const event of normalizedEvents) {
                const activeTurnId = input.getCurrentTurnId();
                switch (event._tag) {
                  case "ModeChanged":
                    yield* logNative(input.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpModeChangedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: activeTurnId,
                        modeId: event.modeId,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "AssistantItemStarted":
                    if (!activeTurnId) {
                      break;
                    }
                    assistantItemTurnIdByItemId.set(event.itemId, activeTurnId);
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    break;
                  case "AssistantItemCompleted": {
                    const eventTurnId = assistantItemTurnIdByItemId.get(event.itemId);
                    if (!eventTurnId) {
                      break;
                    }
                    assistantItemTurnIdByItemId.delete(event.itemId);
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: eventTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    break;
                  }
                  case "PlanUpdated":
                    if (!activeTurnId) {
                      break;
                    }
                    yield* logNative(input.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: activeTurnId,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "ToolCallUpdated":
                    if (!activeTurnId) {
                      break;
                    }
                    yield* logNative(input.threadId, "session/update", event.rawPayload);
                    {
                      const planUpdate = extractCopilotPlanUpdate(event.toolCall);
                      if (planUpdate) {
                        yield* offerRuntimeEvent(
                          makeAcpPlanUpdatedEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: input.threadId,
                            turnId: activeTurnId,
                            payload: planUpdate,
                            source: "acp.jsonrpc",
                            method: "session/update",
                            rawPayload: event.rawPayload,
                          }),
                        );
                      }
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    break;
                  case "ContentDelta": {
                    const eventTurnId = event.itemId
                      ? assistantItemTurnIdByItemId.get(event.itemId)
                      : activeTurnId;
                    if (!eventTurnId) {
                      break;
                    }
                    yield* logNative(input.threadId, "session/update", event.rawPayload);
                    const fatal = detectCopilotFatalToolCallError(event.text);
                    const friendlyMessage = fatal
                      ? copilotFatalToolCallErrorMessage(fatal)
                      : undefined;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: eventTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        streamKind: event.streamKind,
                        text: friendlyMessage ?? event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    if (fatal && friendlyMessage) {
                      input.onFatalCopilotError?.(eventTurnId, friendlyMessage);
                      // Best-effort: SIGINT the Copilot CLI so the in-flight
                      // session/prompt fails fast. The send-turn finalizer will
                      // recreate the runtime so a fresh thread can recover.
                      yield* acp.signalProcess("SIGINT").pipe(Effect.ignore);
                    }
                    break;
                  }
                }
              }
            }),
          ),
        ).pipe(Effect.forkChild);

        sessionScopeTransferred = true;
        return {
          started,
          scope: sessionScope,
          acp,
          notificationFiber,
        } satisfies CopilotRuntimeResources;
      }).pipe(Effect.scoped);

    const restartRuntimeInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        const resumeSessionId = parseCopilotResume(ctx.session.resumeCursor)?.sessionId;
        const cwd = ctx.session.cwd;
        if (!resumeSessionId) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ctx.threadId,
            detail: "Copilot runtime restart requires a resumable session id.",
          });
        }
        if (!cwd) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ctx.threadId,
            detail: "Copilot runtime restart requires a working directory.",
          });
        }

        yield* closeRuntimeInternal(ctx);
        const runtime = yield* openRuntime({
          threadId: ctx.threadId,
          cwd,
          runtimeMode: ctx.session.runtimeMode,
          copilotSettings: ctx.copilotSettings,
          pendingApprovals: ctx.pendingApprovals,
          pendingUserInputs: ctx.pendingUserInputs,
          fullAccessWarningKeys: ctx.fullAccessWarningKeys,
          resumeSessionId,
          getCurrentTurnId: () => ctx.activeTurnId,
          onFatalCopilotError: (turnId, message) => {
            ctx.fatalErrorByTurnId.set(turnId, message);
            if (ctx.cancelRequestedTurnId !== turnId) {
              ctx.cancelRequestedTurnId = turnId;
            }
          },
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              ctx.stopped = true;
              sessions.delete(ctx.threadId);
            }),
          ),
        );

        ctx.scope = runtime.scope;
        ctx.acp = runtime.acp;
        ctx.notificationFiber = runtime.notificationFiber;
        ctx.session = {
          ...ctx.session,
          resumeCursor: {
            schemaVersion: COPILOT_RESUME_VERSION,
            sessionId: runtime.started.sessionId,
          },
          updatedAt: yield* nowIso,
        };
      });

    const applyRequestedMode = (input: {
      readonly ctx: CopilotSessionContext | undefined;
      readonly threadId: ThreadId;
      readonly interactionMode: Parameters<typeof resolveCopilotAcpModeId>[0];
    }) =>
      input.ctx?.acp.setMode(resolveCopilotAcpModeId(input.interactionMode)).pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
        ),
        Effect.asVoid,
      ) ?? Effect.void;

    const applyRequestedModel = (input: {
      readonly ctx: CopilotSessionContext | undefined;
      readonly threadId: ThreadId;
      readonly model: string | undefined;
    }) =>
      input.ctx && input.model
        ? input.ctx.acp.setModel(input.model).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                input.ctx!.session = {
                  ...input.ctx!.session,
                  model: input.model,
                  updatedAt: new Date().toISOString(),
                };
              }),
            ),
            Effect.asVoid,
          )
        : Effect.void;

    const applyRequestedReasoning = (input: {
      readonly ctx: CopilotSessionContext | undefined;
      readonly threadId: ThreadId;
      readonly reasoning: string | undefined;
    }) => {
      const { ctx, reasoning, threadId } = input;
      if (!ctx || !reasoning) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const configOptions = yield* ctx.acp.getConfigOptions;
        const reasoningConfig = configOptions.find((option) => {
          const id = option.id.trim().toLowerCase();
          const name = option.name.trim().toLowerCase();
          const category = option.category?.trim().toLowerCase() ?? "";
          return (
            option.type === "select" &&
            (id === "reasoning_effort" ||
              category === "thought_level" ||
              name.includes("reasoning") ||
              name.includes("effort"))
          );
        });
        if (!reasoningConfig || reasoningConfig.type !== "select") {
          return;
        }
        const supportedValues = collectSessionConfigOptionValues(reasoningConfig);
        const effectiveReasoning =
          supportedValues.length === 0 || supportedValues.includes(reasoning)
            ? reasoning
            : supportedValues.includes(reasoningConfig.currentValue)
              ? // The active model does not support the requested reasoning effort
                // (e.g. Copilot Claude models only accept "medium"). Clamp to the
                // current valid value instead of failing the turn, which also clears
                // any stale value carried over from a previously selected model.
                reasoningConfig.currentValue
              : undefined;
        if (effectiveReasoning === undefined) {
          return;
        }
        yield* ctx.acp
          .setConfigOption(reasoningConfig.id, effectiveReasoning)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/set_config_option", cause),
            ),
          );
      }).pipe(Effect.asVoid);
    };

    const startSessionInternal = (input: CopilotStartSessionInput) =>
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

          const cwd = nodePath.resolve(input.cwd.trim());
          const copilotModelSelection =
            input.modelSelection?.instanceId === "copilot" ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const copilotSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.map((settings) => settings.providers.copilot),
            Effect.mapError(
              (error) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: error.message,
                  cause: error,
                }),
            ),
          );
          const copilotConfig = yield* readCopilotMergedSettings({ cwd }).pipe(
            Effect.provide(NodeServices.layer),
          );
          const effectiveModel = resolveEffectiveCopilotModel({
            configuredModel: copilotConfig.model,
            selectedModel: copilotModelSelection?.model,
          });

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const fullAccessWarningKeys = new Set<string>();
          let ctx: CopilotSessionContext | undefined;
          const resumeSessionId = parseCopilotResume(input.resumeCursor)?.sessionId;
          const runtime = yield* openRuntime({
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            copilotSettings: { binaryPath: copilotSettings.binaryPath },
            pendingApprovals,
            pendingUserInputs,
            fullAccessWarningKeys,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(input.resumeFallback ? { resumeFallback: input.resumeFallback } : {}),
            getCurrentTurnId: () => ctx?.activeTurnId,
            onFatalCopilotError: (turnId, message) => {
              if (!ctx) return;
              ctx.fatalErrorByTurnId.set(turnId, message);
              if (ctx.cancelRequestedTurnId !== turnId) {
                ctx.cancelRequestedTurnId = turnId;
              }
            },
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(effectiveModel ? { model: effectiveModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: COPILOT_RESUME_VERSION,
              sessionId: runtime.started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          return yield* Effect.gen(function* () {
            ctx = {
              threadId: input.threadId,
              copilotSettings: { binaryPath: copilotSettings.binaryPath },
              session,
              scope: runtime.scope,
              acp: runtime.acp,
              notificationFiber: runtime.notificationFiber,
              pendingApprovals,
              pendingUserInputs,
              fullAccessWarningKeys,
              turns: [],
              activeTurnId: undefined,
              inFlightTurnId: undefined,
              cancelRequestedTurnId: undefined,
              fatalErrorByTurnId: new Map<TurnId, string>(),
              stopped: false,
            };

            yield* applyRequestedMode({
              ctx,
              threadId: input.threadId,
              interactionMode: input.interactionMode,
            });
            yield* applyRequestedModel({
              ctx,
              threadId: input.threadId,
              model: effectiveModel,
            });
            yield* applyRequestedReasoning({
              ctx,
              threadId: input.threadId,
              reasoning: getModelSelectionStringOptionValue(copilotModelSelection, "reasoning"),
            });

            sessions.set(input.threadId, ctx);

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: runtime.started.initializeResult },
            });
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "GitHub Copilot ACP session ready" },
            });
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: runtime.started.sessionId },
            });
            for (const warning of copilotConfig.warnings) {
              yield* offerRuntimeEvent({
                type: "config.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: {
                  summary: "GitHub Copilot config warning",
                  details: warning.message,
                  path: warning.path,
                },
              });
            }

            return session;
          }).pipe(
            Effect.onError(() =>
              sessions.get(input.threadId) === ctx ? Effect.void : closeRuntimeResources(runtime),
            ),
          );
        }),
      );

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      startSessionInternal(input);

    const forkSession: CopilotAdapterShape["forkSession"] = (input) =>
      withThreadLock(
        input.sourceThreadId,
        Effect.gen(function* () {
          if (input.threadId === input.sourceThreadId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "forkSession",
              issue: "sourceThreadId and threadId must be different.",
            });
          }
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "forkSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const sourceCtx = yield* requireSession(input.sourceThreadId);
          const sourceStarted = yield* sourceCtx.acp
            .start()
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/start", cause),
              ),
            );
          if (!hasCopilotAcpForkCapability(sourceStarted)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/fork",
              detail: COPILOT_FORK_UNSUPPORTED_DETAIL,
            });
          }
          const sourceSessionId = parseCopilotResume(sourceCtx.session.resumeCursor)?.sessionId;
          if (!sourceSessionId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/fork",
              detail: `Source thread '${input.sourceThreadId}' has no Copilot session id to fork.`,
            });
          }
          const rawCwd = input.cwd ?? sourceCtx.session.cwd;
          if (!rawCwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "forkSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = nodePath.resolve(rawCwd.trim());

          const forked = yield* sourceCtx.acp
            .forkSession({ cwd, mcpServers: [] })
            .pipe(Effect.mapError((cause) => mapCopilotForkAcpError(input.sourceThreadId, cause)));

          return yield* startSessionInternal({
            threadId: input.threadId,
            provider: PROVIDER,
            ...(input.providerInstanceId !== undefined
              ? { providerInstanceId: input.providerInstanceId }
              : {}),
            cwd,
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            ...(input.interactionMode !== undefined
              ? { interactionMode: input.interactionMode }
              : {}),
            runtimeMode: input.runtimeMode,
            resumeCursor: {
              schemaVersion: COPILOT_RESUME_VERSION,
              sessionId: forked.sessionId,
            },
            resumeFallback: "fail",
          });
        }),
      );

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.instanceId === "copilot" ? input.modelSelection : undefined;
        const model = resolveEffectiveCopilotModel({
          configuredModel: ctx.session.model,
          selectedModel: turnModelSelection?.model,
        });

        yield* applyRequestedMode({
          ctx,
          threadId: input.threadId,
          interactionMode: input.interactionMode,
        });
        yield* applyRequestedModel({
          ctx,
          threadId: input.threadId,
          model,
        });
        yield* applyRequestedReasoning({
          ctx,
          threadId: input.threadId,
          reasoning: getModelSelectionStringOptionValue(turnModelSelection, "reasoning"),
        });

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
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

        ctx.activeTurnId = turnId;
        ctx.inFlightTurnId = turnId;
        ctx.cancelRequestedTurnId = undefined;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* ctx.acp.discardPendingEvents;

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: model ?? "auto" },
        });

        const promptOutcome = yield* ctx.acp
          .prompt({
            prompt: promptParts,
          })
          .pipe(
            Effect.matchCauseEffect({
              onSuccess: (result) => Effect.succeed({ _tag: "completed" as const, result }),
              onFailure: (cause) => {
                const squashed = Cause.squash(cause);
                const error = squashed instanceof Error ? squashed : new Error(String(squashed));
                return ctx.cancelRequestedTurnId === turnId
                  ? Effect.succeed({ _tag: "cancelled" as const })
                  : Effect.fail(toProcessError(input.threadId, error));
              },
            }),
            Effect.ensuring(Effect.sync(() => clearTurnState(ctx, turnId))),
          );

        const stopReason =
          promptOutcome._tag === "completed" ? promptOutcome.result.stopReason : "cancelled";
        const fatalErrorMessage = ctx.fatalErrorByTurnId.get(turnId);
        ctx.fatalErrorByTurnId.delete(turnId);
        ctx.turns.push({
          id: turnId,
          items: [
            {
              prompt: retainedPromptParts(promptParts),
              result:
                promptOutcome._tag === "completed"
                  ? retainedPromptResult(promptOutcome.result)
                  : { stopReason: fatalErrorMessage ? "failed" : "cancelled" },
            },
          ],
        });
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          model,
        };

        if (fatalErrorMessage && !ctx.stopped) {
          // The Copilot CLI's per-session conversation history is now poisoned
          // by an orphaned tool call; restart the underlying process so the
          // ACP transport is healthy for any follow-up operations on this
          // thread (the user still needs to start a fresh thread to recover
          // — communicated via the friendly error message).
          yield* restartRuntimeInternal(ctx).pipe(Effect.ignore);
        }

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: fatalErrorMessage
            ? {
                state: "failed",
                stopReason: "copilot_fatal_capi_error",
                errorMessage: fatalErrorMessage,
              }
            : {
                state: stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: stopReason ?? null,
              },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const turnId = ctx.inFlightTurnId;
        if (!turnId || ctx.cancelRequestedTurnId === turnId) {
          return;
        }

        ctx.cancelRequestedTurnId = turnId;
        if (ctx.stopped) {
          return;
        }

        yield* ctx.acp
          .signalProcess("SIGINT")
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "process/signal", error),
            ),
          );
        if (ctx.stopped) {
          return;
        }
        yield* restartRuntimeInternal(ctx);
      });

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
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
        ctx.pendingApprovals.delete(requestId);
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
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
            method: "session/user_input",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
        ctx.pendingUserInputs.delete(requestId);
      });

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: cloneCopilotTurns(ctx.turns) };
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: cloneCopilotTurns(ctx.turns) };
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      ).pipe(Effect.ensuring(deleteThreadSemaphore(threadId)));

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        yield* Effect.forEach(contexts, stopSessionInternal, { discard: true });
        yield* clearThreadSemaphores;
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        yield* Effect.forEach(contexts, stopSessionInternal, { discard: true });
        yield* clearThreadSemaphores;
      }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      forkSession,
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies CopilotAdapterShape;
  });
}

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(opts?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(opts));
}
