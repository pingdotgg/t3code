/**
 * CopilotAdapter — GitHub Copilot via the first-party `@github/copilot-sdk`.
 *
 * Replaces the previous `copilot --acp` (ACP) integration. The SDK spawns and
 * drives the same `copilot` runtime binary over a typed JSON-RPC protocol,
 * exposing real per-model capabilities (reasoning effort, context-window tier)
 * that the ACP path could not drive. One `CopilotClient` (one runtime process)
 * backs every thread this adapter owns; each thread gets its own
 * `CopilotSession`.
 *
 * @module CopilotAdapter
 */

import {
  ApprovalRequestId,
  type CopilotSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import type {
  CopilotSession,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  makeCopilotSdkClient,
  type CopilotSdkClient,
  type CopilotSdkError,
} from "../sdk/CopilotSdkClient.ts";
import {
  resolveCopilotSdkTunables,
  type CopilotContextTier,
  type CopilotReasoningEffort,
  type CopilotSdkSessionTunables,
} from "../sdk/CopilotSdkModels.ts";
import {
  makeSdkAssistantItemEvent,
  makeSdkContentDeltaEvent,
  makeSdkRequestOpenedEvent,
  makeSdkRequestResolvedEvent,
  makeSdkToolCompleteEvent,
  makeSdkToolProgressEvent,
  makeSdkToolStartEvent,
  permissionDetailFromSdk,
  toolItemTypeFromSdk,
} from "../sdk/CopilotSdkRuntimeEvents.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_RESUME_VERSION = 1 as const;

function parseCopilotResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== COPILOT_RESUME_VERSION) return undefined;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return undefined;
  return { sessionId: record.sessionId.trim() };
}

/** Maps a T3 approval decision to the SDK's permission-decision result. */
function decisionToSdkResult(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession":
      return { kind: "approve-for-session" };
    case "decline":
    case "cancel":
    default:
      return { kind: "reject" };
  }
}

interface PendingApproval {
  readonly resolve: (decision: ProviderApprovalDecision) => void;
  readonly request: PermissionRequest;
}

/** Internal event carried from JS callbacks into the Effect consumer fiber. */
type InternalEvent =
  | { readonly _tag: "sdk"; readonly event: SessionEvent }
  | {
      readonly _tag: "permissionOpened";
      readonly requestId: ApprovalRequestId;
      readonly request: PermissionRequest;
    }
  | {
      readonly _tag: "permissionResolved";
      readonly requestId: ApprovalRequestId;
      readonly request: PermissionRequest;
      readonly decision: ProviderApprovalDecision;
    };

/**
 * How a turn's completion `Deferred` settled: a normal or aborted idle, or a
 * provider/runtime error that must surface as a `failed` turn (with a non-empty
 * message) rather than silently reporting `completed` or wedging the thread.
 */
type TurnOutcome = {
  readonly aborted: boolean;
  readonly error?: { readonly message: string; readonly detail?: unknown };
};

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly sdkSession: CopilotSession;
  readonly internalQueue: Queue.Queue<InternalEvent>;
  consumerFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly toolItemTypes: Map<string, ToolLifecycleItemType>;
  activeTurnId: TurnId | undefined;
  activeTurnCompletion: Deferred.Deferred<TurnOutcome> | undefined;
  appliedModel: string | undefined;
  appliedReasoningEffort: string | undefined;
  appliedContextTier: string | undefined;
  stopped: boolean;
}

export interface CopilotAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
}

export function makeCopilotAdapter(
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
    const path = yield* Path.Path;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Effect.scope;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CopilotSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    // Lazily-created shared SDK client (one `copilot` runtime process). Created
    // on first session start and torn down with the adapter scope.
    const clientRef = yield* SynchronizedRef.make<CopilotSdkClient | undefined>(undefined);

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(Effect.orDie);
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    // Best-effort NDJSON record of the raw SDK traffic (mirrors the ACP
    // adapters' native logging), so `nativeEventLogPath` / the driver's
    // injected logger capture Copilot native events.
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
          Effect.logWarning("Failed to write native Copilot notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const getClient: Effect.Effect<CopilotSdkClient, CopilotSdkError> =
      SynchronizedRef.modifyEffect(clientRef, (existing) =>
        existing
          ? Effect.succeed([existing, existing] as const)
          : makeCopilotSdkClient({
              binaryPath: copilotSettings.binaryPath,
              ...(options?.environment ? { environment: options.environment } : {}),
            }).pipe(
              Effect.provideService(Scope.Scope, adapterScope),
              Effect.map((client) => [client, client] as const),
            ),
      );

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

    const settlePendingApprovalsAsCancelled = (ctx: CopilotSessionContext) =>
      Effect.sync(() => {
        for (const pending of ctx.pendingApprovals.values()) {
          pending.resolve("cancel");
        }
        ctx.pendingApprovals.clear();
      });

    // ── SDK event → runtime event translation (runs in the Effect consumer) ──
    const emitSdkEvent = (ctx: CopilotSessionContext, event: SessionEvent) =>
      Effect.gen(function* () {
        const base = {
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
        };
        switch (event.type) {
          case "assistant.message_start":
            yield* offerRuntimeEvent(
              makeSdkAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                itemId: event.data.messageId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "assistant.message_delta":
            if (!event.data.deltaContent) return;
            yield* offerRuntimeEvent(
              makeSdkContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                itemId: event.data.messageId,
                text: event.data.deltaContent,
                streamKind: "assistant_text",
                method: "assistant.message_delta",
                rawPayload: event.data,
              }),
            );
            return;
          case "assistant.message":
            yield* offerRuntimeEvent(
              makeSdkAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                itemId: event.data.messageId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "assistant.reasoning_delta":
            if (!event.data.deltaContent) return;
            yield* offerRuntimeEvent(
              makeSdkContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                itemId: event.data.reasoningId,
                text: event.data.deltaContent,
                streamKind: "reasoning_text",
                method: "assistant.reasoning_delta",
                rawPayload: event.data,
              }),
            );
            return;
          case "tool.execution_start": {
            // Classify the tool once at start and remember it, so the
            // completion/progress events keep the same item type instead of
            // collapsing to a generic `dynamic_tool_call`.
            const itemType = toolItemTypeFromSdk({
              toolName: event.data.toolName,
              ...(event.data.mcpServerName ? { mcpServerName: event.data.mcpServerName } : {}),
            });
            ctx.toolItemTypes.set(event.data.toolCallId, itemType);
            yield* offerRuntimeEvent(
              makeSdkToolStartEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                data: event.data,
                itemType,
              }),
            );
            return;
          }
          case "tool.execution_progress":
            yield* offerRuntimeEvent(
              makeSdkToolProgressEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                toolCallId: event.data.toolCallId,
                itemType: ctx.toolItemTypes.get(event.data.toolCallId) ?? "dynamic_tool_call",
                detail: event.data.progressMessage,
                rawPayload: event.data,
              }),
            );
            return;
          case "tool.execution_complete": {
            const itemType = ctx.toolItemTypes.get(event.data.toolCallId) ?? "dynamic_tool_call";
            ctx.toolItemTypes.delete(event.data.toolCallId);
            yield* offerRuntimeEvent(
              makeSdkToolCompleteEvent({
                stamp: yield* makeEventStamp(),
                ...base,
                data: event.data,
                itemType,
              }),
            );
            return;
          }
          case "session.idle":
            // `session.idle` is the SOLE terminal settle point for a turn (see
            // the `abort` case). Because a turn's guard stays closed until its
            // own idle settles it, this idle always belongs to the active turn —
            // an interrupted turn is never force-settled while its idle is still
            // in flight, so no later turn can be admitted to catch a stale one.
            if (ctx.activeTurnCompletion) {
              yield* Deferred.succeed(ctx.activeTurnCompletion, {
                aborted: event.data?.aborted === true,
              });
            }
            return;
          case "abort":
            // Do NOT settle here. `abort` fires when a cancel is requested and is
            // followed by a `session.idle` (with `aborted: true`); settling on
            // `abort` would reopen the turn guard before that idle arrives, so the
            // idle would then settle a newer turn. Let `session.idle` settle it.
            return;
          case "session.error": {
            // A sub-agent scoped error (`agentId` set) belongs to a nested run,
            // not this turn — never let it fail the root turn.
            if (event.agentId !== undefined) {
              yield* Effect.logWarning("Copilot SDK sub-agent session error", {
                message: event.data.message,
                errorType: event.data.errorType,
                agentId: event.agentId,
              });
              return;
            }
            const message = event.data.message?.trim() || "GitHub Copilot session error.";
            // A root `session.error` is terminal for the turn here. Even a
            // `rate_limit` flagged `eligibleForAutoSwitch` does NOT recover: T3
            // registers no auto-switch handler, so the SDK auto-declines the
            // switch, the model stays rate-limited, and the turn produces no
            // output — reporting it as a silent `completed` would bury the rate
            // limit in the server log. Surface it as a `runtime.error` and settle
            // the turn as `failed`; without this the failure only hit the log and
            // the turn either reported `completed` or hung on its `Deferred.await`.
            // (If T3 ever registers an auto-switch handler so a switch genuinely
            // continues the turn, revisit this to skip settling when
            // `event.data.eligibleForAutoSwitch === true`.)
            yield* offerRuntimeEvent({
              type: "runtime.error",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: { message, class: "provider_error", detail: event.data },
            });
            if (ctx.activeTurnCompletion) {
              yield* Deferred.succeed(ctx.activeTurnCompletion, {
                aborted: false,
                error: { message, detail: event.data },
              });
            }
            return;
          }
          case "session.shutdown": {
            // Only a root-session shutdown ends this turn; a sub-agent scoped
            // shutdown (`agentId` set) leaves the root session running.
            if (event.agentId !== undefined) return;
            // The runtime is going away. A crash (`shutdownType: "error"`) is a
            // transport failure — surface it and fail the in-flight turn; a
            // routine shutdown mid-turn is treated as an abort. Either way the
            // active turn must be settled so a lost trailing `session.idle`
            // doesn't wedge the thread (every later turn rejected as in-progress).
            if (event.data.shutdownType === "error") {
              const message =
                event.data.errorReason?.trim() || "GitHub Copilot runtime shut down unexpectedly.";
              yield* offerRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: { message, class: "transport_error", detail: event.data },
              });
              if (ctx.activeTurnCompletion) {
                yield* Deferred.succeed(ctx.activeTurnCompletion, {
                  aborted: false,
                  error: { message, detail: event.data },
                });
              }
            } else if (ctx.activeTurnCompletion) {
              yield* Deferred.succeed(ctx.activeTurnCompletion, { aborted: true });
            }
            return;
          }
          default:
            return;
        }
      });

    const consumeInternalEvents = (ctx: CopilotSessionContext) =>
      Stream.fromQueue(ctx.internalQueue).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            switch (item._tag) {
              case "sdk":
                yield* logNative(ctx.threadId, `session.event:${item.event.type}`, item.event);
                yield* emitSdkEvent(ctx, item.event);
                return;
              case "permissionOpened":
                yield* logNative(ctx.threadId, "permission.requested", item.request);
                yield* offerRuntimeEvent(
                  makeSdkRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    requestId: RuntimeRequestId.make(item.requestId),
                    request: item.request,
                    detail: permissionDetailFromSdk(item.request),
                  }),
                );
                return;
              case "permissionResolved":
                yield* logNative(ctx.threadId, "permission.completed", {
                  request: item.request,
                  decision: item.decision,
                });
                yield* offerRuntimeEvent(
                  makeSdkRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    requestId: RuntimeRequestId.make(item.requestId),
                    request: item.request,
                    decision: item.decision,
                  }),
                );
                return;
            }
          }),
        ),
      );

    const stopSessionInternal = (ctx: CopilotSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx);
        if (ctx.activeTurnCompletion) {
          yield* Deferred.succeed(ctx.activeTurnCompletion, { aborted: true });
        }
        yield* Effect.promise(() => ctx.sdkSession.disconnect().catch(() => {}));
        yield* Queue.shutdown(ctx.internalQueue);
        if (ctx.consumerFiber) {
          yield* Fiber.interrupt(ctx.consumerFiber);
        }
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
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
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const client = yield* getClient.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start the Copilot SDK runtime client.",
                  cause,
                }),
            ),
          );

          const tunables = resolveCopilotSdkTunables(modelSelection?.options);
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const internalQueue = yield* Queue.unbounded<InternalEvent>();
          const runtimeMode = input.runtimeMode;
          const approvalCounter = { value: 0 };

          const onEvent = (event: SessionEvent): void => {
            Queue.offerUnsafe(internalQueue, { _tag: "sdk", event });
          };

          const onPermissionRequest = async (
            request: PermissionRequest,
          ): Promise<PermissionRequestResult> => {
            if (runtimeMode === "full-access") {
              return { kind: "approve-once" };
            }
            approvalCounter.value += 1;
            const requestId = ApprovalRequestId.make(
              `copilot-perm-${boundInstanceId}-${approvalCounter.value}`,
            );
            const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
              pendingApprovals.set(requestId, { resolve, request });
              Queue.offerUnsafe(internalQueue, { _tag: "permissionOpened", requestId, request });
            });
            pendingApprovals.delete(requestId);
            Queue.offerUnsafe(internalQueue, {
              _tag: "permissionResolved",
              requestId,
              request,
              decision,
            });
            return decisionToSdkResult(decision);
          };

          // `reasoningEffort` / `contextTier` are cast to the SDK's own unions
          // at the boundary (see CopilotSdkModels for why they're mirrored).
          const baseConfig = {
            workingDirectory: cwd,
            streaming: true,
            onEvent,
            onPermissionRequest,
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(tunables.reasoningEffort ? { reasoningEffort: tunables.reasoningEffort } : {}),
            ...(tunables.contextTier ? { contextTier: tunables.contextTier } : {}),
          } as unknown as SessionConfig & ResumeSessionConfig;

          const resumeSessionId = parseCopilotResume(input.resumeCursor)?.sessionId;
          const sdkSession = yield* (
            resumeSessionId
              ? client.resumeSession(resumeSessionId, baseConfig as ResumeSessionConfig)
              : client.createSession(baseConfig as SessionConfig)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to create or resume the Copilot SDK session.",
                  cause,
                }),
            ),
          );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: COPILOT_RESUME_VERSION,
              sessionId: sdkSession.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: CopilotSessionContext = {
            threadId: input.threadId,
            session,
            sdkSession,
            internalQueue,
            consumerFiber: undefined,
            pendingApprovals,
            turns: [],
            toolItemTypes: new Map(),
            activeTurnId: undefined,
            activeTurnCompletion: undefined,
            appliedModel: modelSelection?.model,
            appliedReasoningEffort: tunables.reasoningEffort,
            appliedContextTier: tunables.contextTier,
            stopped: false,
          };

          // Fork into the adapter scope, not the `startSession` fiber: a
          // child fiber would be interrupted when `startSession` returns,
          // leaving SDK callbacks queued but never drained (so `session.idle`
          // could never complete a turn). The fiber is torn down explicitly in
          // `stopSessionInternal`.
          ctx.consumerFiber = yield* consumeInternalEvents(ctx).pipe(Effect.forkIn(adapterScope));
          sessions.set(input.threadId, ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: { sessionId: sdkSession.sessionId } },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "GitHub Copilot SDK session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: sdkSession.sessionId },
          });

          return session;
        }),
      );

    // Applies a model / tunable change to the live SDK session when it differs
    // from what's already applied, so we don't disrupt the runtime each turn.
    const applyModelSelection = (
      ctx: CopilotSessionContext,
      model: string | undefined,
      tunables: CopilotSdkSessionTunables,
    ) =>
      Effect.gen(function* () {
        const targetModel = model?.trim() || ctx.appliedModel;
        if (!targetModel) return;
        const changed =
          targetModel !== ctx.appliedModel ||
          tunables.reasoningEffort !== ctx.appliedReasoningEffort ||
          tunables.contextTier !== ctx.appliedContextTier;
        if (!changed) return;
        const setModelOptions = {
          ...(tunables.reasoningEffort ? { reasoningEffort: tunables.reasoningEffort } : {}),
          ...(tunables.contextTier ? { contextTier: tunables.contextTier } : {}),
        } as Parameters<CopilotSession["setModel"]>[1];
        yield* Effect.tryPromise({
          try: () => ctx.sdkSession.setModel(targetModel, setModelOptions),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/set_model",
              detail: "Failed to apply the Copilot model selection.",
              cause,
            }),
        });
        ctx.appliedModel = targetModel;
        ctx.appliedReasoningEffort = tunables.reasoningEffort;
        ctx.appliedContextTier = tunables.contextTier;
      });

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // One turn at a time per thread. A second concurrent turn would
        // overwrite `activeTurnCompletion` (stranding the first on its
        // `Deferred.await`) and misattribute the in-flight SDK events, so
        // reject it rather than corrupt state. The orchestration layer already
        // serializes turns, so this is a defensive guard.
        if (ctx.activeTurnCompletion) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A turn is already in progress for this thread.",
          });
        }
        const turnId = TurnId.make(yield* randomUUIDv4);
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        // A turn without its own model selection must not wipe the tunables
        // applied at session start — carry the currently-applied effort/tier
        // forward rather than resetting them to empty.
        const tunables: CopilotSdkSessionTunables = turnModelSelection
          ? resolveCopilotSdkTunables(turnModelSelection.options)
          : {
              ...(ctx.appliedReasoningEffort
                ? { reasoningEffort: ctx.appliedReasoningEffort as CopilotReasoningEffort }
                : {}),
              ...(ctx.appliedContextTier
                ? { contextTier: ctx.appliedContextTier as CopilotContextTier }
                : {}),
            };

        // Build + validate prompt and attachments BEFORE touching the live SDK
        // session. `applyModelSelection` mutates the session's model/tunables, so
        // if it ran first a turn rejected below would still leave those changes
        // applied — validate, then apply.
        const promptText = input.input?.trim() ?? "";
        const attachments: NonNullable<MessageOptions["attachments"]> = [];
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/send",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            attachments.push({ type: "file", path: attachmentPath });
          }
        }

        if (!promptText && attachments.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        yield* applyModelSelection(ctx, model, tunables);

        ctx.activeTurnId = turnId;
        const completion = yield* Deferred.make<TurnOutcome>();
        ctx.activeTurnCompletion = completion;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: model?.trim() ?? undefined },
        });

        const messageOptions: MessageOptions = {
          prompt: promptText,
          ...(attachments.length > 0 ? { attachments } : {}),
          agentMode: input.interactionMode === "plan" ? "plan" : "interactive",
        };

        // Clear the active-turn markers however the turn ends — success,
        // failure, or interruption while awaiting `completion`. Without this
        // finalizer an interrupted/failed `sendTurn` would leave
        // `activeTurnCompletion` set and permanently wedge the session (every
        // later turn rejected as "already in progress"). Also keeps
        // `listSessions()` from reporting an idle session as active.
        const clearActiveTurn = Effect.sync(() => {
          ctx.activeTurnCompletion = undefined;
          ctx.activeTurnId = undefined;
          ctx.session = { ...ctx.session, activeTurnId: undefined };
        });

        const result = yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => ctx.sdkSession.send(messageOptions),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/send",
                detail: "Failed to send the Copilot turn.",
                cause,
              }),
          });
          return yield* Deferred.await(completion);
        }).pipe(Effect.ensuring(clearActiveTurn));

        // If the session was stopped or replaced while this turn was in flight
        // (`stopSessionInternal` settles the deferred and already emitted
        // `session.exited`), don't mutate the now-detached context or publish a
        // stale `turn.completed` — those events would arrive after the session's
        // exit and, on replacement, after the new session's start events.
        if (ctx.stopped) {
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }

        ctx.turns.push({ id: turnId, items: [{ prompt: promptText, result }] });
        ctx.session = {
          ...ctx.session,
          updatedAt: yield* nowIso,
          model: model?.trim(),
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          // A provider/runtime error settles the turn as `failed` (the
          // `runtime.error` was already emitted at the error site); otherwise it
          // is a clean completion or an abort-driven cancellation.
          payload: result.error
            ? { state: "failed", stopReason: "error", errorMessage: result.error.message }
            : {
                state: result.aborted ? "cancelled" : "completed",
                stopReason: result.aborted ? "cancelled" : null,
              },
        });

        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx);
        const completion = ctx.activeTurnCompletion;
        if (!completion) {
          // No active turn to interrupt; still fire the abort so the runtime
          // stops any residual work. Any resulting idle finds no active turn.
          yield* Effect.promise(() => ctx.sdkSession.abort().catch(() => {}));
          return;
        }
        const acknowledged = yield* Effect.promise(() =>
          ctx.sdkSession.abort().then(
            () => true,
            () => false,
          ),
        );
        // On a clean ack we do NOT settle locally: the SDK delivers THIS turn's
        // own (aborted) `session.idle`, which settles `completion` and only then
        // reopens the turn guard — so no later turn can be admitted while this
        // turn's terminal event is still in flight, and the session-scoped idle
        // (which carries no turn id) can never mis-settle a newer turn. Waiting
        // for the real idle also keeps the turn honestly "running" while an
        // attached shell command the abort didn't kill is still finishing.
        // Only when the abort was NOT acknowledged is an idle not guaranteed, so
        // settle here to keep `sendTurn` from stranding on its `Deferred.await`.
        if (!acknowledged) {
          yield* Deferred.succeed(completion, { aborted: true });
        }
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
        // Consume the request atomically: remove it before resolving so a
        // second `respondToRequest` for the same id reports "unknown" rather
        // than succeeding with a decision the already-settled promise ignores.
        yield* Effect.sync(() => {
          ctx.pendingApprovals.delete(requestId);
          pending.resolve(decision);
        });
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "copilot/ask_question",
          detail: `Structured user input is not supported by the Copilot SDK adapter (request ${requestId}).`,
        });
      });

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
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
        // Roll back the underlying SDK conversation, not just the local turn
        // list — otherwise the next `send` still carries the discarded turns.
        // The rewind points are per-user-turn boundaries; rewinding to the one
        // `numTurns` back (conversation-only) discards that turn and everything
        // after. Sort by timestamp so ordering doesn't depend on the API's
        // return order. Only mirror the local turns once the backend rewind
        // actually lands, so we never report a rollback that didn't happen.
        const rewound = yield* Effect.tryPromise({
          try: async () => {
            const { points, unavailableReason } =
              await ctx.sdkSession.rpc.history.listRewindPoints();
            if (unavailableReason || points.length === 0) return false;
            const ordered = [...points].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            const target = ordered[Math.max(0, ordered.length - numTurns)];
            if (!target) return false;
            const result = await ctx.sdkSession.rpc.history.rewind({
              eventId: target.eventId,
              mode: "conversation",
            });
            return result.outcome === "success";
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "history/rewind",
              detail: "Failed to rewind the Copilot conversation.",
              cause,
            }),
        });

        if (!rewound) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "history/rewind",
            detail: "GitHub Copilot could not roll back the conversation for this session.",
          });
        }

        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromQueue(runtimeEventQueue);

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
    } satisfies CopilotAdapterShape;
  });
}
