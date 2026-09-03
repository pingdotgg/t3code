import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

interface AcpToolCallTrackedState {
  readonly state: AcpToolCallState;
  readonly lastEmittedDetailLength: number | undefined;
  readonly skippedSinceEmit: number;
}

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

export interface AcpSessionEventStreamBarrier {
  readonly _tag: "EventStreamBarrier";
  readonly acknowledge: Deferred.Deferred<void>;
}

export type AcpSessionRuntimeEvent =
  | AcpParsedSessionEvent
  | AcpSessionEventStreamBarrier
  | {
      readonly _tag: "ConnectionTerminated";
      readonly error: EffectAcpErrors.AcpError;
    };

const defaultSessionLoadTimeout = Duration.seconds(90);
const defaultSessionLoadReplayIdleGap = Duration.seconds(2);
const defaultCancelTimeout = Duration.seconds(15);
const maxStartupMetadataUpdates = 32;
// Antigravity can emit an accepted 16 KiB Google authorization URL on stderr.
const maxStderrChunkLength = 32_768;

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly resumeMethod?: "load" | "resume";
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  /** Native cancellation waits for the prompt response and the getEvents consumer to drain. */
  readonly cancelBehavior?: "interrupt" | "wait-for-prompt";
  readonly cancelTimeout?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** Extra workspace roots the agent may read and write besides `cwd`. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Transforms provider stdout before protocol parsing and protocol logging. */
  readonly transformStdout?: EffectAcpClient.AcpClientOptions["transformStdout"];
  /** Normalizes provider-specific fields before notification queues or runtime state retain them. */
  readonly transformSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /** Receives bounded stderr chunks. Redact secrets before logging. A failure closes the runtime. */
  readonly onStderr?: (text: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly requestLogger?: (event: AcpSessionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

export interface AcpSessionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpSessionRuntimeStartResult {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
}

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    /**
     * Registers a handler for `session/request_permission`.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
    /**
     * Registers a handler for `session/elicitation`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
     */
    readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
    /**
     * Registers a handler for `fs/read_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
     */
    readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
    /**
     * Registers a handler for `fs/write_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
     */
    readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
    /**
     * Registers a handler for `terminal/create`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/create
     */
    readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
    /**
     * Registers a handler for `terminal/output`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/output
     */
    readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
    /**
     * Registers a handler for `terminal/wait_for_exit`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
     */
    readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
    /**
     * Registers a handler for `terminal/kill`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
     */
    readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
    /**
     * Registers a handler for `terminal/release`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/release
     */
    readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
    /**
     * Registers a handler for `session/update`.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
    /**
     * Registers a handler for `session/elicitation/complete`.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
     */
    readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
    /**
     * Registers a fallback extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
    /**
     * Registers a fallback extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
    /**
     * Registers a typed extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
    /**
     * Registers a typed extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
    /**
     * Sends only `initialize` and returns the agent's response. Health probes use this to read
     * advertised capabilities without authenticating or opening a session, so a probe can never
     * start an interactive login or boot MCP servers.
     * @see https://agentclientprotocol.com/protocol/schema#initialize
     */
    readonly initialize: () => Effect.Effect<
      EffectAcpSchema.InitializeResponse,
      EffectAcpErrors.AcpError
    >;
    /**
     * Initializes the ACP connection, authenticates, and loads, resumes, or creates the session.
     * Concurrent calls share the same in-flight startup and a failed startup may be retried.
     */
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    /** Stream of parsed root-session events and connection failures. */
    readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
    /** Waits for queued events to be processed, or for the runtime scope to close. */
    readonly drainEvents: Effect.Effect<void>;
    /** Latest mode state observed from session setup and `session/update` notifications. */
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    /** Latest configuration options observed from session setup and configuration writes. */
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    /**
     * Sends a prompt turn to the active session. `options.dispatched` settles once the
     * `session/prompt` RPC is registered as the active prompt, so a caller that forks this
     * effect knows when a later `cancel` will target this prompt.
     * @see https://agentclientprotocol.com/protocol/schema#session/prompt
     */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
      options?: { readonly dispatched?: Deferred.Deferred<void> },
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a real ACP `session/cancel` notification for the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/cancel
     */
    readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
    /**
     * Selects the active mode through the negotiated `mode` configuration option.
     * This is a no-op when the requested mode is already active.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setMode: (
      modeId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
    /**
     * Updates a session configuration option and the runtime configuration snapshot.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
    /**
     * Selects the base model through the negotiated model configuration option.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
     */
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    /**
     * Selects the active model through the unstable ACP `session/set_model` capability.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_model
     */
    readonly setSessionModel: (
      modelId: string,
      meta?: EffectAcpSchema.SetSessionModelRequest["_meta"],
    ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension request and records it through the request logger.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    /**
     * Sends a generic ACP extension notification.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }
>()("t3/provider/acp/AcpSessionRuntime") {}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

interface AcpAssistantSegmentState {
  readonly nextSegmentIndex: number;
  readonly activeItemId?: string;
}

interface EnsureActiveAssistantSegmentResult {
  readonly itemId: string;
  readonly startedEvent?: Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>;
}

interface AcpActivePrompt {
  readonly fiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly completed: Deferred.Deferred<void>;
}

export const make = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallTrackedState>());
    const assistantItemRuntimeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to generate an ACP assistant item runtime identifier.",
            cause,
          }),
      ),
    );
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    const startupMetadataRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionNotification>>(
      [],
    );
    const notificationSemaphore = yield* Semaphore.make(1);
    const terminationErrorRef = yield* Ref.make<Option.Option<EffectAcpErrors.AcpError>>(
      Option.none(),
    );
    const stoppingRef = yield* Ref.make(false);
    const stderrFailure = yield* Deferred.make<never, EffectAcpErrors.AcpError>();
    const runtimeClosed = yield* Deferred.make<void>();
    const promptSerializationSemaphore = yield* Semaphore.make(1);
    const promptDispatchSemaphore = yield* Semaphore.make(1);
    const activePromptRef = yield* Ref.make<Option.Option<AcpActivePrompt>>(Option.none());
    const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());

    const ensureConnected = Effect.gen(function* () {
      const error = yield* Ref.get(terminationErrorRef);
      if (Option.isSome(error)) {
        return yield* error.value;
      }
      if (yield* Ref.get(stoppingRef)) {
        return yield* new EffectAcpErrors.AcpTransportError({
          detail: "The ACP session runtime is closed.",
          cause: undefined,
        });
      }
    });

    const recordTermination = Effect.fn("AcpSessionRuntime.recordTermination")(function* (
      error: EffectAcpErrors.AcpError,
    ) {
      if (yield* Ref.get(stoppingRef)) {
        return;
      }
      const firstTermination = yield* Ref.modify(terminationErrorRef, (current) =>
        Option.isSome(current)
          ? ([false, current] as const)
          : ([true, Option.some(error)] as const),
      );
      if (!firstTermination) {
        return;
      }
      yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
      yield* Queue.offer(eventQueue, { _tag: "ConnectionTerminated", error });
    });

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          (options.onStderr
            ? Effect.raceFirst(effect, Deferred.await(stderrFailure))
            : effect
          ).pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const spawnCommand = yield* resolveSpawnCommand(options.spawn.command, options.spawn.args, {
      ...(options.spawn.env ? { env: options.spawn.env } : {}),
      extendEnv: options.spawn.extendEnv ?? true,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: options.spawn.env } : {}),
          extendEnv: options.spawn.extendEnv ?? true,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        (options.onStderr
          ? options.onStderr(chunk.slice(-maxStderrChunkLength))
          : Effect.void
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Deferred.fail(stderrFailure, error);
              yield* recordTermination(error);
              yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
            }),
          ),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.transformStdout ? { transformStdout: options.transformStdout } : {}),
        ...(options.transformSessionUpdate
          ? { transformSessionUpdate: options.transformSessionUpdate }
          : {}),
        onTermination: recordTermination,
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    const processSessionUpdate = (notification: EffectAcpSchema.SessionNotification) =>
      handleSessionUpdate({
        queue: eventQueue,
        modeStateRef,
        configOptionsRef,
        toolCallsRef,
        assistantSegmentRef,
        assistantItemRuntimeId,
        params: notification,
      });

    yield* acp.handleSessionUpdate((notification) =>
      notificationSemaphore.withPermit(
        Effect.gen(function* () {
          if (Option.isSome(yield* Ref.get(terminationErrorRef))) {
            return;
          }
          const gate = yield* Ref.get(sessionLoadGateRef);
          if (
            Option.isSome(gate) &&
            gate.value.active &&
            notification.sessionId === options.resumeSessionId
          ) {
            const lastActivityAtMillis = yield* Clock.currentTimeMillis;
            yield* Ref.set(
              sessionLoadGateRef,
              Option.some({
                ...gate.value,
                lastActivityAtMillis,
              }),
            );
          }
          if (sessionUpdateIsReplay(notification)) {
            return;
          }
          const startState = yield* Ref.get(startStateRef);
          if (startState._tag === "Starting") {
            if (isStartupMetadataUpdate(notification)) {
              yield* Ref.update(startupMetadataRef, (current) =>
                [
                  ...current.filter(
                    (previous) =>
                      previous.sessionId !== notification.sessionId ||
                      previous.update.sessionUpdate !== notification.update.sessionUpdate,
                  ),
                  notification,
                ].slice(-maxStartupMetadataUpdates),
              );
            }
            return;
          }
          // One runtime projects one root ACP session. Child-session updates need
          // explicit lineage routing and must never be flattened into this stream.
          if (
            startState._tag !== "Started" ||
            notification.sessionId !== startState.result.sessionId
          ) {
            return;
          }
          yield* processSessionUpdate(notification);
        }),
      ),
    );
    yield* Scope.addFinalizer(
      runtimeScope,
      Ref.set(stoppingRef, true).pipe(Effect.andThen(Deferred.succeed(runtimeClosed, undefined))),
    );
    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      yield* ensureConnected;
      const state = yield* Ref.get(startStateRef);
      if (state._tag === "Started") {
        return state.result;
      }
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);
        if (!configOption) {
          return;
        }
        if (configOption.type === "boolean") {
          if (typeof value === "boolean") {
            return;
          }
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }
        if (typeof value !== "string") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }
        const allowedValues = collectSessionConfigOptionValues(configOption);
        if (allowedValues.includes(value)) {
          return;
        }
        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = Effect.fn("AcpSessionRuntime.updateConfigOptions")(function* (
      response: EffectAcpSchema.SetSessionConfigOptionResponse,
    ) {
      const configOptions = sessionConfigOptionsFromSetup(response);
      yield* Ref.set(configOptionsRef, configOptions);
      yield* Queue.offer(eventQueue, {
        _tag: "ConfigOptionsUpdated",
        configOptions,
        rawPayload: response,
      });
    });

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);
              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }
              const requestPayload =
                typeof value === "boolean"
                  ? ({
                      sessionId: started.sessionId,
                      configId,
                      type: "boolean",
                      value,
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                  : ({
                      sessionId: started.sessionId,
                      configId,
                      value: String(value),
                    } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);
              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const initializePayload = {
      protocolVersion: 1,
      clientCapabilities: initializeClientCapabilities,
      clientInfo: options.clientInfo,
    } satisfies EffectAcpSchema.InitializeRequest;
    const sendInitialize = runLoggedRequest(
      "initialize",
      initializePayload,
      acp.agent.initialize(initializePayload),
    );

    const startOnce = Effect.gen(function* () {
      const initializeResult = yield* sendInitialize;

      const authenticatePayload = {
        methodId: options.authMethodId,
      } satisfies EffectAcpSchema.AuthenticateRequest;

      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );

      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      if (options.resumeSessionId && options.resumeMethod === "resume") {
        if (!initializeResult.agentCapabilities?.sessionCapabilities?.resume) {
          return yield* new EffectAcpErrors.AcpTransportError({
            method: "session/resume",
            detail: "The ACP agent does not support session/resume.",
            cause: undefined,
          });
        }
        const resumePayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
          ...(options.additionalDirectories && options.additionalDirectories.length > 0
            ? { additionalDirectories: options.additionalDirectories }
            : {}),
        } satisfies EffectAcpSchema.ResumeSessionRequest;
        sessionId = options.resumeSessionId;
        sessionSetupResult = yield* runLoggedRequest(
          "session/resume",
          resumePayload,
          acp.agent.resumeSession(resumePayload).pipe(
            Effect.timeoutOption(options.sessionLoadTimeout ?? defaultSessionLoadTimeout),
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.succeed(result.value)
                : Effect.fail(
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "session/resume",
                      detail: "session/resume timed out waiting for the agent response.",
                      cause: undefined,
                    }),
                  ),
            ),
          ),
        );
      } else if (options.resumeSessionId) {
        const loadPayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        } satisfies EffectAcpSchema.LoadSessionRequest;
        const sessionLoadTimeout = Duration.fromInputUnsafe(
          options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
        );
        const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
          options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
        );

        yield* Ref.set(
          sessionLoadGateRef,
          Option.some({
            active: true,
            lastActivityAtMillis: undefined,
            idleGap: sessionLoadReplayIdleGap,
            initializeResult,
          }),
        );

        sessionId = options.resumeSessionId;
        sessionSetupResult = yield* Effect.gen(function* () {
          yield* logRequest({
            method: "session/load",
            payload: loadPayload,
            status: "started",
          });

          const idleFiber = yield* waitForSessionLoadReplayIdle({
            gateRef: sessionLoadGateRef,
          }).pipe(Effect.forkIn(runtimeScope));
          const loaded = yield* Effect.raceFirst(
            acp.agent.loadSession(loadPayload),
            Fiber.join(idleFiber),
          ).pipe(
            Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)),
            Effect.timeoutOption(sessionLoadTimeout),
            Effect.flatMap((result) =>
              Option.match(result, {
                onNone: () =>
                  Effect.fail(
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "session/load",
                      detail: "session/load timed out waiting for RPC response or replay idle gap",
                      cause: undefined,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
            Effect.tap((result) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "failed",
                cause,
              }),
            ),
          );

          return loaded;
        }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
          ...(options.additionalDirectories && options.additionalDirectories.length > 0
            ? { additionalDirectories: options.additionalDirectories }
            : {}),
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
      } satisfies AcpStartedState;
      return nextState;
    });

    const start = Effect.gen(function* () {
      yield* ensureConnected;
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.result), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((result) =>
                  notificationSemaphore.withPermit(
                    Effect.gen(function* () {
                      const error = yield* Ref.get(terminationErrorRef);
                      if (Option.isSome(error)) {
                        return yield* error.value;
                      }
                      yield* Ref.set(startStateRef, { _tag: "Started", result });
                      const metadata = yield* Ref.getAndSet(startupMetadataRef, []);
                      for (const notification of metadata) {
                        if (notification.sessionId === result.sessionId) {
                          yield* processSessionUpdate(notification);
                        }
                      }
                      yield* Deferred.succeed(deferred, result);
                    }),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                    Effect.andThen(Ref.set(startupMetadataRef, [])),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    const drainEvents = Effect.gen(function* () {
      if (yield* Ref.get(stoppingRef)) {
        return;
      }
      const acknowledge = yield* Deferred.make<void>();
      yield* Queue.offer(eventQueue, { _tag: "EventStreamBarrier", acknowledge });
      yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(runtimeClosed));
    });

    const retireRuntime = Effect.fn("AcpSessionRuntime.retireRuntime")(function* (
      error: EffectAcpErrors.AcpError,
    ) {
      yield* recordTermination(error);
      yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
    });

    const cancel = Effect.gen(function* () {
      const started = yield* getStartedState;
      const activePrompt = yield* Ref.get(activePromptRef);
      if (options.cancelBehavior !== "wait-for-prompt") {
        if (Option.isSome(activePrompt)) {
          yield* Fiber.interrupt(activePrompt.value.fiber).pipe(Effect.ignore);
        }
        // Write cancel before a replacement prompt can reach the agent.
        yield* acp.agent.cancel({ sessionId: started.sessionId }).pipe(Effect.ignore);
        return;
      }

      yield* acp.agent.cancel({ sessionId: started.sessionId });
      if (Option.isNone(activePrompt)) {
        return;
      }
      const completed = yield* Effect.gen(function* () {
        const result = yield* Fiber.await(activePrompt.value.fiber);
        yield* Deferred.await(activePrompt.value.completed);
        if (Option.isNone(yield* Ref.get(terminationErrorRef))) {
          yield* drainEvents;
        }
        return result;
      }).pipe(Effect.timeoutOption(options.cancelTimeout ?? defaultCancelTimeout));
      if (Option.isNone(completed)) {
        const error = new EffectAcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "session/cancel",
          detail: "The ACP agent did not finish cancellation. Its process was stopped.",
          cause: undefined,
        });
        yield* retireRuntime(error);
        return yield* error;
      }
      if (Exit.isFailure(completed.value)) {
        return yield* Effect.failCause(completed.value.cause);
      }
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      initialize: () => ensureConnected.pipe(Effect.andThen(sendInitialize)),
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      drainEvents,
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      prompt: (payload, promptOptions?) =>
        promptSerializationSemaphore.withPermit(
          Effect.acquireUseRelease(
            promptDispatchSemaphore.withPermit(
              Effect.gen(function* () {
                const started = yield* getStartedState;
                yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
                const requestPayload = {
                  sessionId: started.sessionId,
                  ...payload,
                } satisfies EffectAcpSchema.PromptRequest;
                const completed = yield* Deferred.make<void>();
                const fiber = yield* runLoggedRequest(
                  "session/prompt",
                  requestPayload,
                  acp.agent.prompt(requestPayload),
                ).pipe(Effect.forkIn(runtimeScope));
                const active = { fiber, completed } satisfies AcpActivePrompt;
                yield* Ref.set(activePromptRef, Option.some(active));
                if (promptOptions?.dispatched) {
                  yield* Deferred.succeed(promptOptions.dispatched, undefined);
                }
                return active;
              }),
            ),
            (activePrompt) =>
              Fiber.join(activePrompt.fiber).pipe(
                Effect.catchCause((cause) =>
                  options.cancelBehavior !== "wait-for-prompt" && Cause.hasInterruptsOnly(cause)
                    ? Effect.succeed({
                        stopReason: "cancelled",
                      } satisfies EffectAcpSchema.PromptResponse)
                    : Effect.failCause(cause),
                ),
                Effect.tap(() =>
                  closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef }),
                ),
              ),
            (activePrompt, result) =>
              Effect.gen(function* () {
                if (
                  options.cancelBehavior === "wait-for-prompt" &&
                  Exit.isFailure(result) &&
                  Cause.hasInterrupts(result.cause)
                ) {
                  yield* retireRuntime(
                    new EffectAcpErrors.AcpTransportError({
                      method: "session/prompt",
                      detail: "The ACP prompt stopped before the agent confirmed completion.",
                      cause: undefined,
                    }),
                  );
                }
                yield* Fiber.interrupt(activePrompt.fiber).pipe(Effect.ignore);
                yield* Ref.set(activePromptRef, Option.none());
                yield* Deferred.succeed(activePrompt.completed, undefined);
              }),
          ),
        ),
      cancel:
        options.cancelBehavior === "wait-for-prompt"
          ? promptDispatchSemaphore.withPermit(cancel)
          : cancel,
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }
            return setConfigOption("mode", modeId).pipe(
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      setSessionModel: (modelId, meta) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              modelId,
              ...(meta !== undefined ? { _meta: meta } : {}),
            } satisfies EffectAcpSchema.SetSessionModelRequest;
            return runLoggedRequest(
              "session/set_model",
              requestPayload,
              acp.agent.setSessionModel(requestPayload),
            );
          }),
        ),
      request: (method, payload) =>
        ensureConnected.pipe(
          Effect.andThen(runLoggedRequest(method, payload, acp.raw.request(method, payload))),
        ),
      notify: (method, payload) =>
        ensureConnected.pipe(Effect.andThen(acp.raw.notify(method, payload))),
    } satisfies AcpSessionRuntime["Service"];
  });

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> => Layer.effect(AcpSessionRuntime, make(options));

function sessionConfigOptionsFromSetup(
  response:
    | {
        readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null;
      }
    | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> {
  return response?.configOptions ?? [];
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

function isStartupMetadataUpdate(notification: EffectAcpSchema.SessionNotification): boolean {
  switch (notification.update.sessionUpdate) {
    case "current_mode_update":
    case "config_option_update":
    case "available_commands_update":
      return true;
    default:
      return false;
  }
}

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  configOptionsRef,
  toolCallsRef,
  assistantSegmentRef,
  assistantItemRuntimeId,
  params,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallTrackedState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly assistantItemRuntimeId: string;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (params.update.sessionUpdate === "config_option_update") {
      yield* Ref.set(configOptionsRef, params.update.configOptions);
    }
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        yield* closeActiveAssistantSegment({
          queue,
          assistantSegmentRef,
        });
        const { merged, decision } = yield* Ref.modify(toolCallsRef, (current) => {
          const tracked = current.get(event.toolCall.toolCallId);
          const previous = tracked?.state;
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const decision = decideToolCallUpdateEmission({
            previous,
            next: nextToolCall,
            lastEmittedDetailLength: tracked?.lastEmittedDetailLength,
            skippedSinceEmit: tracked?.skippedSinceEmit ?? 0,
          });
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, {
              state: nextToolCall,
              lastEmittedDetailLength: decision.emit
                ? toolCallProgressLength(nextToolCall)
                : tracked?.lastEmittedDetailLength,
              skippedSinceEmit: decision.skippedSinceEmit,
            });
          }
          return [{ merged: nextToolCall, decision }, next] as const;
        });
        if (!decision.emit) {
          continue;
        }
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      if (event._tag === "ContentDelta") {
        if (event.text.trim().length === 0) {
          const assistantSegmentState = yield* Ref.get(assistantSegmentRef);
          if (!assistantSegmentState.activeItemId) {
            continue;
          }
        }
        const itemId = yield* ensureActiveAssistantSegment({
          queue,
          assistantSegmentRef,
          sessionId: params.sessionId,
          assistantItemRuntimeId,
        });
        yield* Queue.offer(queue, {
          ...event,
          itemId,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  });

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}

const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
  `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
  assistantItemRuntimeId,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
  readonly assistantItemRuntimeId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, assistantItemRuntimeId, current.nextSegmentIndex);
      return [
        {
          itemId,
          startedEvent: {
            _tag: "AssistantItemStarted",
            itemId,
          } satisfies Extract<AcpParsedSessionEvent, { readonly _tag: "AssistantItemStarted" }>,
        },
        {
          nextSegmentIndex: current.nextSegmentIndex + 1,
          activeItemId: itemId,
        } satisfies AcpAssistantSegmentState,
      ] as const;
    },
  ).pipe(
    Effect.flatMap((result) =>
      result.startedEvent
        ? Queue.offer(queue, result.startedEvent).pipe(Effect.as(result.itemId))
        : Effect.succeed(result.itemId),
    ),
  );

const closeActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
}: {
  readonly queue: Queue.Queue<AcpSessionRuntimeEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
}) =>
  Ref.modify(assistantSegmentRef, (current) => {
    if (!current.activeItemId) {
      return [undefined, current] as const;
    }
    return [
      {
        _tag: "AssistantItemCompleted",
        itemId: current.activeItemId,
      } satisfies AcpParsedSessionEvent,
      {
        nextSegmentIndex: current.nextSegmentIndex,
      } satisfies AcpAssistantSegmentState,
    ] as const;
  }).pipe(Effect.flatMap((event) => (event ? Queue.offer(queue, event) : Effect.void)));
