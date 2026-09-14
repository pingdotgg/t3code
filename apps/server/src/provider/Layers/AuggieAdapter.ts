/**
 * AuggieAdapter — Augment CLI (`auggie --acp`) over ACP.
 *
 * Auggie ships no ACP extensions, so this adapter is the shared
 * `AcpSessionRuntime` wired to T3's runtime events plus three provider-shaped
 * decisions:
 *
 *   - Auggie's two session modes are `default` and `ask`. `ask` answers
 *     without editing, which is what T3 calls plan mode. There is no native
 *     approval-only mode, so `approval-required` stays on `default` and
 *     supervision comes from T3's own approval flow.
 *   - The model catalog is only advertised on `session/new` and
 *     `session/load`, never on `initialize`. The adapter forwards what it sees
 *     to the driver so the picker fills in after the first real session.
 *   - `session/load` fails for a session that has not completed a turn yet,
 *     because Auggie only persists a session once it has history. A resume
 *     that reports the session as missing falls back to a fresh session
 *     instead of failing the turn.
 *
 * @module AuggieAdapter
 */

import {
  ApprovalRequestId,
  type AuggieSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ServerProviderModel,
  type ThreadId,
  TurnId,
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
import type * as EffectAcpSchema from "effect-acp/schema";

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
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyAuggieAcpModelSelection,
  currentAuggieModelIdFromSessionSetup,
  makeAuggieAcpRuntime,
  resolveAuggieAcpBaseModelId,
} from "../acp/AuggieAcpSupport.ts";
import { buildAuggieModelsFromSessionModelState } from "./AuggieProvider.ts";
import { type AuggieAdapterShape } from "../Services/AuggieAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("auggie");
const AUGGIE_RESUME_VERSION = 1 as const;
/** `ask` answers without editing, which is what T3 surfaces as plan mode. */
const ACP_PLAN_MODE_ALIASES = ["ask", "plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["default", "agent", "code", "implement"];
/**
 * Auggie reports a missing session with this JSON-RPC code when asked to load
 * one it never persisted. Treated as "start fresh", not as a turn failure.
 */
const ACP_INVALID_PARAMS_CODE = -32602;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface AuggieAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`auggie`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Receives the catalog Auggie advertised on session setup. The driver folds
   * it into the published snapshot so the model picker stops showing only the
   * `auggie-default` sentinel. Called on every session start; implementations
   * are expected to ignore an unchanged list.
   */
  readonly onModelsDiscovered?: (models: ReadonlyArray<ServerProviderModel>) => Effect.Effect<void>;
  /**
   * Optional per-session settings resolver. Production leaves this undefined
   * and uses the settings captured at construction, because the hydration
   * layer rebuilds the adapter whenever its config changes. Tests set it so a
   * mid-suite `binaryPath` swap reaches the next spawned session.
   */
  readonly resolveSettings?: Effect.Effect<AuggieSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface AuggieSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** ACP model id the session currently runs on, so a reselect is a no-op. */
  currentModelId: string | undefined;
  /**
   * Number of sendTurn prompts in flight or being prepared. >0 means a turn is
   * running, so a new sendTurn steers it and only the last prompt settles it.
   */
  promptsInFlight: number;
  stopped: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuggieResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== AUGGIE_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/**
 * True when the failure is Auggie reporting that the session it was asked to
 * load does not exist. Auggie writes a session to disk only after a turn
 * completes, so a thread interrupted before its first reply resumes into this.
 */
export function isAuggieSessionMissingFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  const message = typeof error.message === "string" ? error.message : "";
  return (
    (code === ACP_INVALID_PARAMS_CODE || code === undefined) && /session not found/i.test(message)
  );
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

/**
 * Auggie has no approval-only mode, so `approval-required` resolves to the
 * editing mode and supervision is left to T3's approval flow. Only plan mode
 * maps to a distinct native mode.
 */
export function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

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
 * Auggie asks for workspace-indexing consent through a normal permission
 * request before the first prompt of a new session. The `allowIndexing`
 * setting already carries the user's answer — `true` is passed as
 * `--allow-indexing` at spawn so the request never arrives, and `false` is
 * declined here. Either way it must never reach the approval UI: it is raised
 * during `session/new`, before the session is registered, so a human answer
 * could not be routed back to it.
 */
const AUGGIE_INDEXING_TOOL_CALL_ID = "workspace-indexing-permission";

export function isAuggieIndexingPermissionRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return request.toolCall?.toolCallId?.trim() === AUGGIE_INDEXING_TOOL_CALL_ID;
}

/** Declines for this session only; never writes a persistent "no" to the user's Auggie config. */
export function selectDeclinedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const rejectOnceOption = request.options.find((option) => option.kind === "reject_once");
  const optionId = rejectOnceOption?.optionId;
  return typeof optionId === "string" && optionId.trim() ? optionId.trim() : undefined;
}

export function makeAuggieAdapter(
  auggieSettings: AuggieSettings,
  options?: AuggieAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("auggie");
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

    const sessions = new Map<ThreadId, AuggieSessionContext>();
    // Keyed separately from `sessions` because Auggie can open a permission
    // request during `session/new`, before the session is registered. Routing
    // replies through this map keeps such a request answerable instead of
    // deadlocking startup on an approval nobody can resolve.
    const pendingApprovalsByThread = new Map<ThreadId, Map<ApprovalRequestId, PendingApproval>>();
    const ownerScope = yield* Effect.scope;
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Auggie runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    // ACP request handlers must fail in the protocol's error channel. Adapter
    // errors raised while answering one (id generation, event publishing) are
    // transport failures from the agent's point of view.
    const mapHandlerFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to answer an Auggie ACP request.",
              cause,
            }),
        ),
      );

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
      ctx: AuggieSessionContext,
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
    ): Effect.Effect<AuggieSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AuggieSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        pendingApprovalsByThread.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const applyRequestedMode = (input: {
      readonly ctx: AuggieSessionContext;
      readonly interactionMode: ProviderInteractionMode | undefined;
    }) =>
      Effect.gen(function* () {
        const requestedModeId = resolveRequestedModeId({
          interactionMode: input.interactionMode,
          modeState: yield* input.ctx.acp.getModeState,
        });
        if (!requestedModeId) {
          return;
        }
        yield* input.ctx.acp
          .setMode(requestedModeId)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.ctx.threadId, "session/set_mode", cause),
            ),
          );
      });

    const applyRequestedModel = (input: {
      readonly ctx: AuggieSessionContext;
      readonly model: string | undefined;
    }) =>
      Effect.gen(function* () {
        const nextModelId = yield* applyAuggieAcpModelSelection({
          runtime: input.ctx.acp,
          currentModelId: input.ctx.currentModelId,
          requestedModelId: input.model,
          mapError: (cause) =>
            mapAcpToAdapterError(PROVIDER, input.ctx.threadId, "session/set_model", cause),
        });
        input.ctx.currentModelId = nextModelId;
      });

    const publishDiscoveredModels = (
      sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ) =>
      Effect.gen(function* () {
        const onModelsDiscovered = options?.onModelsDiscovered;
        if (!onModelsDiscovered) return;
        const models = buildAuggieModelsFromSessionModelState(sessionSetupResult.models);
        if (models.length === 0) return;
        yield* onModelsDiscovered(models);
      });

    const startSession: AuggieAdapterShape["startSession"] = (input) =>
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
          const auggieModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          pendingApprovalsByThread.set(input.threadId, pendingApprovals);
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred
              ? Effect.void
              : Effect.sync(() => {
                  pendingApprovalsByThread.delete(input.threadId);
                }).pipe(Effect.andThen(Scope.close(sessionScope, Exit.void))),
          );
          let ctx!: AuggieSessionContext;

          const resumeSessionId = parseAuggieResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const effectiveAuggieSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : auggieSettings;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const buildRuntime = (resumeFrom: string | undefined, scope: Scope.Closeable) =>
            makeAuggieAcpRuntime({
              auggieSettings: effectiveAuggieSettings,
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
              ...(resumeFrom ? { resumeSessionId: resumeFrom, resumeMethod: "load" as const } : {}),
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
              Effect.provideService(Scope.Scope, scope),
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

          const registerHandlers = (acp: AcpSessionRuntime.AcpSessionRuntime["Service"]) =>
            acp.handleRequestPermission((params) =>
              mapHandlerFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (isAuggieIndexingPermissionRequest(params)) {
                    // `allowIndexing: true` never reaches here; the spawn flag
                    // already answered it. Reaching here means the user turned
                    // indexing off, so decline for this session.
                    const declinedOptionId = selectDeclinedPermissionOption(params);
                    return declinedOptionId === undefined
                      ? { outcome: { outcome: "cancelled" as const } }
                      : {
                          outcome: {
                            outcome: "selected" as const,
                            optionId: declinedOptionId,
                          },
                        };
                  }
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
                  pendingApprovals.delete(requestId);
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
                            optionId: acpPermissionOutcome(resolved),
                          },
                  };
                }),
              ),
            );

          const attemptStart = (resumeFrom: string | undefined, scope: Scope.Closeable) =>
            Effect.gen(function* () {
              const runtime = yield* buildRuntime(resumeFrom, scope);
              yield* registerHandlers(runtime);
              const result = yield* runtime
                .start()
                .pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
                  ),
                );
              return { acp: runtime, started: result };
            });

          // Auggie persists a session only once it has completed a turn, so a
          // thread interrupted before its first reply resumes into "Session not
          // found". That is a fresh start, not a turn failure. The attempt runs
          // in a forked scope so a rejected resume releases its agent process
          // instead of leaving it running for the life of the session.
          const attempt =
            resumeSessionId === undefined
              ? undefined
              : yield* Effect.gen(function* () {
                  const resumeScope = yield* Scope.fork(sessionScope, "sequential");
                  return yield* attemptStart(resumeSessionId, resumeScope).pipe(
                    Effect.catch((error) =>
                      Effect.gen(function* () {
                        yield* Effect.ignore(Scope.close(resumeScope, Exit.void));
                        if (
                          !isAuggieSessionMissingFailure(error.cause) &&
                          !isAuggieSessionMissingFailure(error)
                        ) {
                          return yield* Effect.fail(error);
                        }
                        yield* Effect.logInfo(
                          "Auggie session could not be loaded; starting a new one.",
                          { threadId: input.threadId },
                        );
                        return undefined;
                      }),
                    ),
                  );
                });

          const { acp, started } = attempt ?? (yield* attemptStart(undefined, sessionScope));

          yield* publishDiscoveredModels(started.sessionSetupResult);

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: auggieModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: AUGGIE_RESUME_VERSION,
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
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            currentModelId: currentAuggieModelIdFromSessionSetup(started.sessionSetupResult),
            promptsInFlight: 0,
            stopped: false,
          };

          if (auggieModelSelection?.model !== undefined) {
            yield* applyRequestedModel({ ctx, model: auggieModelSelection.model });
          }

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "ConnectionTerminated":
                    // The agent is gone; without this the context would stay in
                    // `sessions` unstopped and every later request would be sent
                    // to a dead runtime. Forked into the adapter scope because
                    // teardown interrupts this very fiber.
                    yield* Effect.logWarning("Auggie ACP connection terminated.", {
                      threadId: ctx.threadId,
                      errorTag: event.error._tag,
                    });
                    yield* stopSessionInternal(ctx).pipe(Effect.forkIn(ownerScope));
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
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
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
              Effect.logError("Failed to process Auggie runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber: a child of
            // startSession would be interrupted the moment startSession
            // returns, dropping every later notification.
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
            payload: { state: "ready", reason: "Auggie ACP session ready" },
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

    const sendTurn: AuggieAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight is a steer: the agent folds
        // the new prompt into the ongoing work, so the active turn id is
        // reused instead of opening a new turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn; the matching
        // decrement is the `ensuring` below.
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveAuggieAcpBaseModelId(model);
          if (model !== undefined) {
            yield* applyRequestedModel({ ctx, model });
          }
          yield* applyRequestedMode({ ctx, interactionMode: input.interactionMode });
          ctx.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
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
              // Auggie's prompt capabilities advertise images only. Generic
              // files reach the agent through the path line ProviderService
              // puts in the prompt.
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

          // ACP has no system-message field; keep runtime context separate from the user's text.
          const result = yield* ctx.acp
            .prompt({
              prompt: [
                ...promptParts,
                {
                  type: "text",
                  text: buildRuntimeInstructions({ harness: "Auggie", model: resolvedModel }),
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
          // in flight must leave the merged turn running.
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

    const interruptTurn: AuggieAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: AuggieAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        // Deliberately not `requireSession`: a request opened while the session
        // was still starting must stay answerable.
        const pending = pendingApprovalsByThread.get(threadId)?.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    // Auggie advertises no question extension, so nothing ever opens a
    // user-input request on this adapter.
    const respondToUserInput: AuggieAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_user_input",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: AuggieAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: AuggieAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
          detail: "Auggie ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: AuggieAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AuggieAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: AuggieAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: AuggieAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Auggie session shutdown event.", { cause }),
        ),
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
    } satisfies AuggieAdapterShape;
  });
}
