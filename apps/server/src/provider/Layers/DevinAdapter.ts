import {
  ApprovalRequestId,
  type DevinSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { DevinAdapterShape } from "../Services/DevinAdapter.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinPrompt,
  currentDevinModelIdFromConfigOptions,
  devinModelOptionValues,
  findDevinModelConfigOption,
  resolveDevinModeId,
  resolveDevinModelId,
  type DevinAcpRuntimeInput,
} from "../acp/DevinAcpSupport.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;
const DEVIN_SIGN_IN_REQUIRED_MESSAGE =
  "Devin is not signed in. Run `devin auth login`, then retry.";

type Adapter = DevinAdapterShape;
type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "start"
  | "setMode"
  | "setModel"
  | "getModeState"
  | "getConfigOptions"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type NativePermission = EffectAcpSchema.RequestPermissionRequest;
type NativePermissionResponse = EffectAcpSchema.RequestPermissionResponse;

const isAcpError = Schema.is(EffectAcpErrors.AcpError);

/**
 * Heuristic for "credentials missing" failures coming back over ACP. The
 * Devin CLI has no dedicated error code for this yet, so the match is loose —
 * it only drives the snapshot's sign-in hint, never a retry.
 */
function isDevinSignInRequiredError(cause: unknown): boolean {
  if (!isAcpError(cause)) return false;
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : "";
  // Word-boundary phrases only: bare `log in`/`sign in` would match "login"
  // in paths and "signing" in tool output, and `forbidden`/`403` can appear in
  // ordinary upstream errors — none of those mean the CLI is signed out.
  return /\bnot (?:signed|logged) in\b|\b(?:sign|log)[ -]?in required\b|\bplease (?:sign|log)[ -]?in\b|\bunauthori[sz]ed\b|\bunauthenticated\b|\bauthentication required\b|\b401\b/i.test(
    message,
  );
}

function mapDevinError(threadId: ThreadId, method: string, cause: EffectAcpErrors.AcpError) {
  return isDevinSignInRequiredError(cause)
    ? new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: DEVIN_SIGN_IN_REQUIRED_MESSAGE,
        cause,
      })
    : mapAcpToAdapterError(PROVIDER, threadId, method, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeResumeCursor(raw: unknown): Option.Option<{ sessionId: string }> {
  if (!isRecord(raw)) return Option.none();
  if (raw.schemaVersion !== DEVIN_RESUME_VERSION) return Option.none();
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return Option.none();
  return Option.some({ sessionId: raw.sessionId.trim() });
}

/** Maps a T3 approval decision onto the ACP permission option Devin offered. */
function devinPermissionOptionId(
  request: NativePermission,
  decision: ProviderApprovalDecision,
): string | undefined {
  const outcome = acpPermissionOutcome(decision).replaceAll("-", "_");
  // `decline` normally maps to reject_once; when Devin only offers
  // reject_always it is still the refusal the user asked for.
  const kinds = decision === "decline" ? [outcome, "reject_always"] : [outcome];
  for (const kind of kinds) {
    const match = request.options.find(
      (option) =>
        typeof option.kind === "string" &&
        (option.kind === kind || option.kind.replaceAll("-", "_") === kind),
    );
    if (match) return match.optionId;
  }
  return undefined;
}

function devinApprovalOptions(request: NativePermission): ReadonlyArray<ProviderApprovalOption> {
  return request.options.flatMap((option): ProviderApprovalOption[] => {
    const label = typeof option.name === "string" && option.name.trim() ? option.name : "Continue";
    switch (option.kind) {
      case "allow_once":
        return [{ decision: "accept" as const, label }];
      case "allow_always":
        return [{ decision: "acceptForSession" as const, label }];
      case "reject_once":
      case "reject_always":
        return [{ decision: "decline" as const, label }];
      default:
        return [];
    }
  });
}

export interface DevinAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly makeRuntime: (
    input: Omit<DevinAcpRuntimeInput, "childProcessSpawner" | "devinSettings" | "environment">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Scope.Scope
  >;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onConfigOptionsUpdated?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly onAuthRequired?: Effect.Effect<void>;
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly request: NativePermission;
  readonly response: Deferred.Deferred<{
    readonly decision: ProviderApprovalDecision;
    readonly result: NativePermissionResponse;
  }>;
}

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface TurnCompletedPayload {
  readonly state: "completed" | "failed" | "cancelled";
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  /** A cancel is in flight: late permission requests are auto-answered. */
  cancelling: boolean;
  /**
   * Saved model slugs the account no longer offers. Resume already fell back
   * for them; the thread's persisted selection is re-sent on every sendTurn,
   * so these keep falling back instead of failing every turn.
   */
  unavailableModelIds: Set<string>;
  stopped: boolean;
  closed: boolean;
  disconnected: boolean;
}

/** Keeps one official `devin acp` process per thread and drains a cancelled prompt before steering. */
export const makeDevinAdapter = Effect.fn("makeDevinAdapter")(function* (
  settings: DevinSettings,
  options: DevinAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Devin event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const cancelRequests = Effect.fn("DevinAdapter.cancelRequests")(function* (
    context: SessionContext,
  ) {
    for (const pending of context.approvals.values()) {
      yield* Deferred.succeed(pending.response, {
        decision: "cancel",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
  });

  const stopContext = (context: SessionContext) =>
    context.stopLock
      .withPermit(
        Effect.gen(function* () {
          if (context.closed) return;
          context.stopped = true;
          yield* Effect.gen(function* () {
            yield* cancelRequests(context);
            if (context.promptFiber && !context.disconnected) {
              yield* Effect.ignore(context.runtime.cancel);
            }
          }).pipe(Effect.ensuring(Scope.close(context.scope, Exit.void)));
          context.closed = true;
          if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
          yield* emit({
            type: "session.exited",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.threadId,
            payload: {
              exitKind: context.disconnected ? "error" : "graceful",
              ...(context.disconnected ? { reason: "Devin process stopped." } : {}),
            },
          });
        }),
      )
      .pipe(Effect.uninterruptible);

  const handlePermission = Effect.fn("DevinAdapter.handlePermission")(function* (
    context: SessionContext,
    request: NativePermission,
  ): Effect.fn.Return<NativePermissionResponse, ProviderAdapterError> {
    // `cancelling` covers the window between `session/cancel` and the prompt
    // settling: ACP expects permission requests to be answered "cancelled"
    // there, otherwise the dying prompt never completes and the cancel
    // timeout kills the process.
    if (context.stopped || context.cancelling || request.sessionId !== context.nativeSessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const requestId = ApprovalRequestId.make(yield* randomId);
    const runtimeRequestId = RuntimeRequestId.make(requestId);
    const turnId = context.activeTurnId;
    const rawPayload = request as unknown;

    const response = yield* Deferred.make<{
      decision: ProviderApprovalDecision;
      result: NativePermissionResponse;
    }>();
    context.approvals.set(requestId, { request, response });
    // A cancel may have started while this request was being set up; an
    // unanswered approval would wedge the dying prompt.
    if (context.cancelling || context.stopped) {
      context.approvals.delete(requestId);
      return { outcome: { outcome: "cancelled" } };
    }
    const permissionRequest = parsePermissionRequest(request);
    return yield* Effect.gen(function* () {
      yield* emit(
        makeAcpRequestOpenedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          approvalOptions: devinApprovalOptions(request),
          detail: permissionRequest.detail ?? "Devin requests permission.",
          args: rawPayload,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload,
        }),
      );
      const answer = yield* Deferred.await(response);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: context.threadId,
          turnId,
          requestId: runtimeRequestId,
          permissionRequest,
          decision: answer.decision,
        }),
      );
      return answer.result;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const handleEvent = Effect.fn("DevinAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    switch (event._tag) {
      case "ModeChanged":
        return;
      case "AvailableCommandsUpdated":
        yield* options.onAvailableCommands?.(event.availableCommands, context.cwd) ?? Effect.void;
        return;
      case "ConfigOptionsUpdated":
        yield* options.onConfigOptionsUpdated?.(event.configOptions) ?? Effect.void;
        return;
      case "ConnectionTerminated":
        context.stopped = true;
        context.disconnected = true;
        yield* stopContext(context).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ThoughtDelta":
      case "ContentDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
            ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(
          makeAcpToolCallEvent({
            stamp: yield* stamp,
            provider: PROVIDER,
            threadId: context.threadId,
            turnId: context.activeTurnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        return;
    }
  });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Devin in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Devin provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Devin session is invalid. Start a new thread.",
          });
        }
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });
        const stopOwned = Effect.suspend(() =>
          context ? stopContext(context).pipe(Effect.ignore) : Scope.close(sessionScope, Exit.void),
        );

        return yield* Effect.gen(function* () {
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          // The attachments dir grant lets the agent read pasted files at the
          // paths ProviderService injects into the turn text. It is a leaf
          // directory holding only uploads.
          const runtime = yield* options.makeRuntime({
            cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            additionalDirectories: [serverConfig.attachmentsDir],
            ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
            // `session/load` replays history without the agent re-running it;
            // Devin advertises loadSession but not session/resume.
            resumeMethod: "load",
            // A resume can run during server-restart recovery where nobody is
            // watching; only an interactive fresh start may fall back to
            // `devin-browser` when credentials are missing.
            browserAuth: Option.isNone(cursor),
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
            ...makeNativeLoggers({
              nativeEventLogger: options.nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          });
          yield* runtime.handleRequestPermission((request) =>
            context
              ? handlePermission(context, request).pipe(
                  Effect.mapError((cause) =>
                    EffectAcpErrors.AcpRequestError.internalError(
                      "Could not process a Devin permission request.",
                      undefined,
                      { cause },
                    ),
                  ),
                )
              : Effect.succeed({
                  outcome: { outcome: "cancelled" },
                } satisfies NativePermissionResponse),
          );
          const started = yield* runtime.start();
          const modelOption = findDevinModelConfigOption(yield* runtime.getConfigOptions);
          const availableModelValues = modelOption ? devinModelOptionValues(modelOption) : [];
          const requested = resolveDevinModelId(input.modelSelection?.model);
          const requestedUnavailable =
            requested !== undefined &&
            availableModelValues.length > 0 &&
            !availableModelValues.includes(requested);
          if (requestedUnavailable && !input.resumeCursor) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              `Devin model '${requested}' is unavailable for this account. Select an available model.`,
            );
          }
          const unavailableModelIds = new Set<string>();
          if (requestedUnavailable) {
            // A resumed thread keeps its saved model selection; when the
            // account no longer offers it, run on the session's current
            // model rather than bricking the thread. sendTurn sees the same
            // stale selection on every turn, so it is remembered here.
            unavailableModelIds.add(requested!);
            yield* Effect.logWarning(
              "Saved Devin model is no longer available; resuming on the session model.",
              { requestedModel: requested },
            );
          }
          const model =
            (yield* applyDevinAcpModelSelection({
              runtime,
              model: requestedUnavailable ? undefined : input.modelSelection?.model,
              mapError: (cause) => cause,
            })) ??
            // No explicit selection: report the model the session is actually
            // running (live config options, fresher than the setup result),
            // then the provider's discovered default.
            currentDevinModelIdFromConfigOptions(yield* runtime.getConfigOptions) ??
            (yield* options.defaultModel ?? Effect.succeed(undefined));
          const requestedMode = resolveDevinModeId({
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modeState: yield* runtime.getModeState,
          });
          if (requestedMode) {
            yield* runtime.setMode(requestedMode);
          }
          yield* options.onSessionStarted?.(started, cwd) ?? Effect.void;
          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(model ? { model } : {}),
            resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
            createdAt,
            updatedAt: createdAt,
          };
          context = {
            threadId: input.threadId,
            cwd,
            nativeSessionId: started.sessionId,
            scope: sessionScope,
            runtime,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            approvals: new Map(),
            turns: [],
            session,
            activeTurnId: undefined,
            promptFiber: undefined,
            generation: 0,
            cancelling: false,
            unavailableModelIds,
            stopped: false,
            closed: false,
            disconnected: false,
          };
          const running = context;
          sessions.set(input.threadId, running);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(running, event),
          ).pipe(
            Effect.catchCause(() => Effect.logError("Could not process a Devin runtime event.")),
            Effect.forkIn(sessionScope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Devin ACP session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* runtime.drainEvents;
          if (running.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          transferred = true;
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.tapError((cause) =>
            isDevinSignInRequiredError(cause)
              ? (options.onAuthRequired ?? Effect.void)
              : Effect.void,
          ),
          Effect.mapError((cause) =>
            isAcpError(cause)
              ? mapDevinError(input.threadId, "session/start", cause)
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/start",
                  detail: "Could not start Devin. Check the provider setup status.",
                  cause,
                }),
          ),
          // The session scope owns the process; the stopOwned path keeps a
          // start failure from leaking it.
          Effect.onError(() => stopOwned.pipe(Effect.ignore)),
        );
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("DevinAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const prompt = yield* buildDevinPrompt({
      input: input.input,
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => mapDevinError(input.threadId, "session/prompt", cause)),
    );
    let intent: TurnIntent | undefined;
    // The caller holds promptLock while it changes or settles the active turn.
    const finishTurn = (turn: TurnIntent, payload: TurnCompletedPayload) =>
      Effect.gen(function* () {
        if (turn.settled || context.stopped || context.generation !== turn.generation) return;
        turn.settled = true;
        // The turn is over; permission requests are owned by the next one.
        context.cancelling = false;
        context.activeTurnId = undefined;
        context.promptFiber = undefined;
        context.session = {
          ...context.session,
          status: payload.state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
          ...(payload.errorMessage
            ? { lastError: payload.errorMessage }
            : { lastError: undefined }),
        };
        yield* emit({
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId: turn.turnId,
          payload,
        });
      }).pipe(Effect.uninterruptible);

    return yield* Effect.gen(function* () {
      const launch = yield* context.promptLock.withPermit(
        Effect.gen(function* () {
          yield* requireSession(input.threadId);
          const requestedModel = input.modelSelection?.model ?? context.session.model;
          const requested = resolveDevinModelId(requestedModel);
          const modelOption = findDevinModelConfigOption(yield* context.runtime.getConfigOptions);
          const availableModelValues = modelOption ? devinModelOptionValues(modelOption) : [];
          const requestedUnavailable =
            requested !== undefined &&
            availableModelValues.length > 0 &&
            !availableModelValues.includes(requested);
          // Availability is checked before anything mutates, so an unknown
          // model fails without changing session state — unless resume
          // already fell back for this saved slug, in which case the session
          // model keeps running.
          if (requestedUnavailable && !context.unavailableModelIds.has(requested)) {
            return yield* EffectAcpErrors.AcpRequestError.invalidParams(
              `Devin model '${requested}' is unavailable for this account. Select an available model.`,
            );
          }
          if (context.promptFiber) {
            // Drain the in-flight prompt before claiming the turn or changing
            // model/mode: the old turn finishes on the configuration it
            // started with, and if the cancel itself fails this sendTurn
            // aborts with the still-running prompt still tracked (no intent
            // was created, so the error path cannot finish the turn).
            context.cancelling = true;
            yield* cancelRequests(context);
            yield* context.runtime.cancel.pipe(
              Effect.tapError(() => Effect.sync(() => (context.cancelling = false))),
            );
            yield* Fiber.await(context.promptFiber);
          }
          const turnId = context.activeTurnId ?? TurnId.make(yield* randomId);
          const steering = context.activeTurnId !== undefined;
          const model = yield* applyDevinAcpModelSelection({
            runtime: context.runtime,
            model: requestedUnavailable ? undefined : requestedModel,
            mapError: (cause) => cause,
          });
          // Register the intent only after model selection so a selection
          // failure cannot emit `turn.completed` for a turn that never
          // emitted `turn.started`.
          const turn: TurnIntent = { turnId, generation: ++context.generation, settled: false };
          intent = turn;
          context.activeTurnId = turnId;
          // A selection that resolved normally means the thread's saved model
          // moved on; remembered stale slugs from a resume no longer apply.
          // Turns without an explicit selection leave the memory alone.
          if (model && input.modelSelection) context.unavailableModelIds.clear();
          // The session may already report a model even when this turn did not
          // switch to one; `turn.started` should carry what is actually used.
          const effectiveModel = model ?? context.session.model;
          if (!steering) {
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: effectiveModel ? { model: effectiveModel } : {},
            });
          }
          const requestedMode = resolveDevinModeId({
            runtimeMode: context.session.runtimeMode,
            interactionMode: input.interactionMode,
            modeState: yield* context.runtime.getModeState,
          });
          if (requestedMode) {
            yield* context.runtime.setMode(requestedMode);
          }
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            ...(model ? { model } : {}),
            updatedAt: yield* nowIso,
          };
          const dispatched = yield* Deferred.make<void>();
          // A fresh prompt is about to own permission requests again; the
          // cancel window ends here even if it was opened on another path.
          context.cancelling = false;
          const fiber = yield* context.runtime
            .prompt(
              {
                prompt: [
                  ...prompt,
                  {
                    type: "text",
                    text: buildRuntimeInstructions({ harness: "Devin", model: effectiveModel }),
                  },
                ],
              },
              { dispatched },
            )
            .pipe(Effect.forkIn(context.scope));
          context.promptFiber = fiber;
          // Fiber.join can skip a scope-close waiter when the child is interrupted.
          // Unwrap the Exit after Fiber.await returns.
          yield* Effect.raceFirst(
            Deferred.await(dispatched),
            Fiber.await(fiber).pipe(
              Effect.flatMap((exit) => exit),
              Effect.asVoid,
            ),
          );
          return { turn, fiber };
        }),
      );
      const result = yield* Fiber.await(launch.fiber).pipe(Effect.flatMap((exit) => exit));
      yield* context.runtime.drainEvents;
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const record = context.turns.find((turn) => turn.id === launch.turn.turnId);
      if (record) record.items.push(result);
      else context.turns.push({ id: launch.turn.turnId, items: [result] });
      yield* context.promptLock.withPermit(
        finishTurn(launch.turn, {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason,
        }),
      );
      return {
        threadId: input.threadId,
        turnId: launch.turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.tapError((cause) =>
        isDevinSignInRequiredError(cause) ? (options.onAuthRequired ?? Effect.void) : Effect.void,
      ),
      Effect.mapError((cause) =>
        isAcpError(cause) ? mapDevinError(input.threadId, "session/prompt", cause) : cause,
      ),
      Effect.tapError((cause) =>
        Effect.suspend(() =>
          intent
            ? context.promptLock.withPermit(
                finishTurn(intent, { state: "failed", errorMessage: cause.message }),
              )
            : Effect.void,
        ),
      ),
      Effect.onInterrupt(() =>
        context.promptLock.withPermit(
          Effect.gen(function* () {
            const turn = intent;
            if (!turn || turn.settled || context.stopped || context.generation !== turn.generation)
              return;
            const promptFiber = context.promptFiber;
            context.cancelling = true;
            yield* cancelRequests(context);
            yield* Effect.ignore(context.runtime.cancel);
            if (promptFiber) yield* Fiber.interrupt(promptFiber);
            yield* finishTurn(turn, { state: "cancelled", stopReason: "cancelled" });
          }),
        ),
      ),
    );
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* context.promptLock
        .withPermit(
          Effect.gen(function* () {
            // A delayed interrupt can target a turn that already completed;
            // cancel only when it still names the active turn.
            const activeTurnId = context.activeTurnId ?? context.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            context.cancelling = true;
            yield* cancelRequests(context);
            yield* context.runtime.cancel.pipe(
              Effect.tapError(() => Effect.sync(() => (context.cancelling = false))),
            );
          }),
        )
        .pipe(Effect.mapError((cause) => mapDevinError(threadId, "session/cancel", cause)));
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "This approval request is no longer pending.",
        });
      }
      const optionId =
        decision === "cancel" ? undefined : devinPermissionOptionId(pending.request, decision);
      if (decision !== "cancel" && optionId === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "Devin did not offer this permission choice. Select one of the available choices.",
        });
      }
      yield* Deferred.succeed(pending.response, {
        decision,
        result: {
          outcome:
            optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
        },
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, _requestId, _answers) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/request_permission",
        detail: "Devin has no pending user-input request for this session.",
      });
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopContext));
  // Unbounded so N active turns cost one 15 s cancel window, not N × 15 s.
  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, {
      discard: true,
      concurrency: "unbounded",
    });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logError("Could not stop a Devin session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
