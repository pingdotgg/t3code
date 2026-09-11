import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type DevinSettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { prepareDevinSkillPrompt } from "../Drivers/DevinSkills.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadTurnSnapshot } from "../Services/ProviderAdapter.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
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
import type { AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import {
  applyDevinMode,
  checkDevinExecutable,
  makeDevinAcpRuntime,
  prepareDevinMcp,
  selectDevinPermissionOption,
} from "../acp/DevinAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const ResumeCursor = Schema.Struct({ sessionId: Schema.NonEmptyString });
const isResumeCursor = Schema.is(ResumeCursor);
type Adapter = ProviderInstance["adapter"];

interface SessionContext {
  readonly runtime: Effect.Success<ReturnType<typeof makeDevinAcpRuntime>>;
  readonly scope: Scope.Closeable;
  readonly sessionId: string;
  readonly lock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  readonly approvals: Map<
    ApprovalRequestId,
    {
      readonly request: EffectAcpSchema.RequestPermissionRequest;
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  >;
  readonly turns: Array<ProviderThreadTurnSnapshot>;
  session: ProviderSession;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  generation: number;
  stopped: boolean;
}

export interface DevinAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
}

/** Each thread owns one ACP process. Closing an instance releases only its own sessions. */
export const makeDevinAdapter = Effect.fn("makeDevinAdapter")(function* (
  settings: DevinSettings,
  options: DevinAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const ownerScope = yield* Effect.scope;
  const makeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, SessionContext>();
  const startLock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const requestError = (method: string, cause: { readonly message: string }) =>
    new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: cause.message, cause });
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
  const stamp = Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: now });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };
  const cancelApprovals = (context: SessionContext) =>
    Effect.forEach(
      context.approvals.values(),
      (pending) => Deferred.succeed(pending.decision, "cancel"),
      { discard: true },
    );

  const stopContext = Effect.fn("DevinAdapter.stopContext")(function* (
    context: SessionContext,
    errorMessage?: string,
  ) {
    return yield* context.stopLock.withPermit(
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        const turnId = context.session.activeTurnId;
        yield* cancelApprovals(context);
        yield* Scope.close(context.scope, Exit.void);
        if (sessions.get(context.session.threadId) === context)
          sessions.delete(context.session.threadId);
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: yield* now,
        };
        if (turnId) {
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: context.session.threadId,
            turnId,
            payload: errorMessage
              ? { state: "failed", errorMessage }
              : { state: "cancelled", stopReason: "cancelled" },
          });
        }
        yield* emit({
          type: "session.exited",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: context.session.threadId,
          payload: { reason: errorMessage ?? "Devin session stopped" },
        });
      }),
    );
  });

  const handleEvent = Effect.fn("DevinAdapter.handleEvent")(function* (
    context: SessionContext,
    event: AcpSessionRuntimeEvent,
  ) {
    if (event._tag === "EventStreamBarrier") {
      yield* Deferred.succeed(event.acknowledge, undefined);
      return;
    }
    if (context.stopped) return;
    const identity = {
      provider: PROVIDER,
      threadId: context.session.threadId,
      turnId: context.session.activeTurnId,
    };
    switch (event._tag) {
      case "ModeChanged":
        return;
      case "AvailableCommandsUpdated":
        yield* (
          options.onAvailableCommands?.(
            event.availableCommands,
            context.session.cwd ?? config.cwd,
          ) ?? Effect.void
        );
        return;
      case "ConfigOptionsUpdated":
        context.session = {
          ...context.session,
          model: yield* context.runtime.applyModel(),
        };
        return;
      case "ConnectionTerminated":
        yield* stopContext(context, event.error.message).pipe(Effect.forkIn(ownerScope));
        return;
      case "AssistantItemStarted":
      case "AssistantItemCompleted":
        yield* emit(
          makeAcpAssistantItemEvent({
            ...identity,
            stamp: yield* stamp,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      case "ContentDelta":
        yield* emit(makeAcpContentDeltaEvent({ ...identity, stamp: yield* stamp, ...event }));
        return;
      case "ThoughtDelta":
        yield* emit(
          makeAcpContentDeltaEvent({
            ...identity,
            stamp: yield* stamp,
            ...event,
            streamKind: "reasoning_text",
          }),
        );
        return;
      case "ToolCallUpdated":
        yield* emit(makeAcpToolCallEvent({ ...identity, stamp: yield* stamp, ...event }));
        return;
      case "PlanUpdated":
        yield* emit(
          makeAcpPlanUpdatedEvent({
            ...identity,
            stamp: yield* stamp,
            ...event,
            source: "acp.jsonrpc",
            method: "session/update",
          }),
        );
        return;
    }
  });

  const requestPermission = Effect.fn("DevinAdapter.requestPermission")(function* (
    context: SessionContext,
    request: EffectAcpSchema.RequestPermissionRequest,
  ) {
    const requestId = ApprovalRequestId.make(yield* randomId);
    const decision = yield* Deferred.make<ProviderApprovalDecision>();
    context.approvals.set(requestId, { request, decision });
    const identity = {
      provider: PROVIDER,
      threadId: context.session.threadId,
      turnId: context.session.activeTurnId,
      requestId: RuntimeRequestId.make(requestId),
      permissionRequest: parsePermissionRequest(request),
    };
    return yield* Effect.gen(function* () {
      const choices = ["accept", "acceptForSession", "decline"] as const;
      yield* emit(
        makeAcpRequestOpenedEvent({
          ...identity,
          stamp: yield* stamp,
          approvalOptions: choices.flatMap((choice) => {
            const option = selectDevinPermissionOption(request, choice);
            return option ? [{ decision: choice, label: option.name }] : [];
          }),
          detail:
            identity.permissionRequest.detail ??
            request.toolCall.title ??
            "Devin requests permission",
          args: request,
          source: "acp.jsonrpc",
          method: "session/request_permission",
          rawPayload: request,
        }),
      );
      const resolved = yield* Deferred.await(decision);
      yield* emit(
        makeAcpRequestResolvedEvent({ ...identity, stamp: yield* stamp, decision: resolved }),
      );
      const option = selectDevinPermissionOption(request, resolved);
      return {
        outcome: option
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" },
      } satisfies EffectAcpSchema.RequestPermissionResponse;
    }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
  });

  const startSession: Adapter["startSession"] = (input) =>
    startLock.withPermit(
      Effect.gen(function* () {
        if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The selected model belongs to another provider instance.",
          });
        }
        if (input.resumeCursor !== undefined && !isResumeCursor(input.resumeCursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Devin session ID is invalid.",
          });
        }
        const resumeSessionId = isResumeCursor(input.resumeCursor)
          ? input.resumeCursor.sessionId
          : undefined;
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        yield* checkDevinExecutable(settings, options.environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout("10 seconds"),
          Effect.mapError((cause) => requestError("session/start", cause)),
        );
        const scope = yield* Scope.make();
        const cwd = input.cwd ?? config.cwd;
        const started = yield* Effect.gen(function* () {
          const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
          const environment = McpProviderSession.withAgentDeviceEnvironment(
            options.environment,
            mcp,
          );
          const mcpConfig = mcp ? yield* prepareDevinMcp(mcp) : undefined;
          const runtime = yield* makeDevinAcpRuntime(settings, environment, {
            cwd,
            resumeSessionId,
            ...(mcpConfig ? { additionalDirectories: [mcpConfig.directory] } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...makeLoggers({
              nativeEventLogger: options.nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          });
          const result = yield* runtime.start();
          if (mcpConfig) yield* mcpConfig.connect(runtime);
          const model = yield* runtime.applyModel(input.modelSelection);
          yield* applyDevinMode(runtime, result.sessionId, input.runtimeMode);
          const createdAt = yield* now;
          const context: SessionContext = {
            runtime,
            scope,
            sessionId: result.sessionId,
            lock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            approvals: new Map(),
            turns: [],
            promptFiber: undefined,
            generation: 0,
            stopped: false,
            session: {
              provider: PROVIDER,
              providerInstanceId: options.instanceId,
              threadId: input.threadId,
              cwd,
              model,
              status: "ready",
              runtimeMode: input.runtimeMode,
              resumeCursor: { sessionId: result.sessionId },
              createdAt,
              updatedAt: createdAt,
            },
          };
          yield* runtime.handleSessionUpdate(({ sessionId, update }) =>
            Effect.gen(function* () {
              if (
                context.stopped ||
                sessionId !== context.sessionId ||
                update.sessionUpdate !== "usage_update"
              )
                return;
              yield* emit({
                type: "thread.token-usage.updated",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: context.session.threadId,
                turnId: context.session.activeTurnId,
                payload: {
                  usage: {
                    usedTokens: update.used,
                    maxTokens: update.size > 0 ? update.size : undefined,
                  },
                },
              });
            }).pipe(Effect.ignoreCause({ log: true })),
          );
          yield* runtime.handleRequestPermission((request) =>
            requestPermission(context, request).pipe(
              // Permission-handler failures deny this action; they must never authorize it.
              Effect.orElseSucceed(
                () =>
                  ({
                    outcome: { outcome: "cancelled" },
                  }) satisfies EffectAcpSchema.RequestPermissionResponse,
              ),
            ),
          );
          sessions.set(input.threadId, context);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            handleEvent(context, event),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not process a Devin runtime event", cause),
            ),
            Effect.forkIn(scope),
          );
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: result.initializeResult },
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
            payload: { providerThreadId: result.sessionId },
          });
          yield* runtime.drainEvents;
          return context.session;
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
          Effect.onError(() =>
            Effect.gen(function* () {
              sessions.delete(input.threadId);
              yield* Scope.close(scope, Exit.void);
            }),
          ),
          Effect.mapError((cause) => requestError("session/start", cause)),
        );
        return started;
      }),
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
    const prompt: Array<EffectAcpSchema.ContentBlock> = [];
    if (input.input?.trim()) {
      const text = yield* prepareDevinSkillPrompt(
        input.input,
        settings,
        options.environment,
        context.session.cwd ?? config.cwd,
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, pathService),
        Effect.mapError((cause) => requestError("session/prompt", cause)),
      );
      prompt.push({ type: "text", text });
    }
    for (const attachment of input.attachments ?? []) {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!path)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid attachment '${attachment.name}'.`,
        });
      if (attachment.type === "file") {
        prompt.push({ type: "text", text: `Attached file: ${path}` });
        continue;
      }
      const bytes = yield* fs.readFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Could not read '${attachment.name}'.`,
              cause,
            }),
        ),
      );
      if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Image '${attachment.name}' is too large.`,
        });
      prompt.push({
        type: "image",
        mimeType: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }
    if (prompt.length === 0)
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "A turn requires text or attachments.",
      });
    // Devin expands a leading command across all text blocks. Appended context
    // can break argument-free commands and otherwise becomes part of $ARGUMENTS.
    // Join user-supplied file references with a space so they remain command arguments.
    const isNativeCommand = prompt[0]?.type === "text" && /^\/\S+(?:\s|$)/.test(prompt[0].text);

    let intent:
      | { readonly turnId: TurnId; readonly generation: number; settled: boolean }
      | undefined;
    const finish = (
      payload: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>["payload"],
    ) =>
      context.lock.withPermit(
        Effect.gen(function* () {
          if (
            context.stopped ||
            !intent ||
            intent.settled ||
            context.generation !== intent.generation
          )
            return;
          intent.settled = true;
          context.promptFiber = undefined;
          context.session = {
            ...context.session,
            activeTurnId: undefined,
            status: payload.state === "failed" ? "error" : "ready",
            updatedAt: yield* now,
            lastError: payload.errorMessage,
          };
          yield* emit({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: intent.turnId,
            payload,
          });
        }),
      );
    return yield* Effect.gen(function* () {
      const launch = yield* context.lock
        .withPermit(
          Effect.gen(function* () {
            yield* requireSession(input.threadId);
            const turnId = context.session.activeTurnId ?? TurnId.make(yield* randomId);
            const steering = context.session.activeTurnId !== undefined;
            const generation = ++context.generation;
            if (steering) intent = { turnId, generation, settled: false };
            if (context.promptFiber) {
              yield* cancelApprovals(context);
              yield* context.runtime.cancel;
              yield* Fiber.await(context.promptFiber);
            }
            const model = yield* context.runtime.applyModel(input.modelSelection);
            yield* applyDevinMode(
              context.runtime,
              context.sessionId,
              context.session.runtimeMode,
              input.interactionMode,
            );
            intent = { turnId, generation, settled: false };
            context.session = {
              ...context.session,
              model,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* now,
              lastError: undefined,
            };
            if (!steering)
              yield* emit({
                type: "turn.started",
                ...(yield* stamp),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: model ? { model } : {},
              });
            const dispatched = yield* Deferred.make<void>();
            const fiber = yield* context.runtime
              .prompt(
                {
                  prompt: isNativeCommand
                    ? [
                        {
                          type: "text",
                          text: prompt
                            .filter((block) => block.type === "text")
                            .map((block) => block.text)
                            .join(" "),
                        },
                        ...prompt.filter((block) => block.type !== "text"),
                      ]
                    : [
                        ...prompt,
                        {
                          type: "text",
                          text: buildRuntimeInstructions({ harness: "Devin", model }),
                        },
                      ],
                },
                { dispatched },
              )
              .pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            yield* Effect.raceFirst(
              Deferred.await(dispatched),
              Fiber.await(fiber).pipe(
                Effect.flatMap((result) => result),
                Effect.asVoid,
              ),
            );
            return { fiber, turnId, generation };
          }),
        )
        .pipe(Effect.mapError((cause) => requestError("session/prompt", cause)));

      const result = yield* Fiber.await(launch.fiber).pipe(
        Effect.flatMap((exit) => exit),
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
        ),
      );
      yield* context.runtime.drainEvents;
      if (context.generation === launch.generation) {
        const previousTurn = context.turns.findIndex((turn) => turn.id === launch.turnId);
        if (previousTurn === -1) context.turns.push({ id: launch.turnId, items: [result] });
        else context.turns[previousTurn] = { id: launch.turnId, items: [result] };
      }
      yield* finish({
        state: result.stopReason === "cancelled" ? "cancelled" : "completed",
        stopReason: result.stopReason,
        usage: result.usage ?? undefined,
      });
      return {
        threadId: input.threadId,
        turnId: launch.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    }).pipe(
      Effect.tapError((cause) => finish({ state: "failed", errorMessage: cause.message })),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          if (
            !intent ||
            intent.settled ||
            context.generation !== intent.generation ||
            context.stopped
          )
            return;
          yield* cancelApprovals(context);
          yield* Effect.ignore(context.runtime.cancel);
          yield* finish({ state: "cancelled", stopReason: "cancelled" });
        }),
      ),
    );
  });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.approvals.get(requestId);
      if (!pending)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "This permission request is no longer pending.",
        });
      if (decision !== "cancel" && !selectDevinPermissionOption(pending.request, decision))
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToRequest",
          issue: "Devin did not offer this permission choice.",
        });
      yield* Deferred.succeed(pending.decision, decision);
    });
  const stopAll = () =>
    Effect.forEach(sessions.values(), (context) => stopContext(context), { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ensuring(PubSub.shutdown(events)), Effect.ignoreCause({ log: true })),
  );
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    respondToRequest,
    interruptTurn: (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        // A steer may be preparing its replacement prompt. Stop must cancel
        // that launch too, after it releases the same lock used by sendTurn.
        yield* context.lock.withPermit(
          Effect.gen(function* () {
            yield* cancelApprovals(context);
            yield* context.runtime.cancel.pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
              ),
            );
          }),
        );
      }),
    respondToUserInput: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "Reply to Devin's question in the conversation.",
        }),
      ),
    stopSession: (threadId) =>
      startLock.withPermit(Effect.flatMap(requireSession(threadId), stopContext)),
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
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin ACP does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
