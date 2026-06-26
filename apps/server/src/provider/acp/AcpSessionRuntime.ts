import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
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
  extractModelConfigId,
  findSessionConfigOption,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

function formatConfigOptionValue(value: string | boolean): string {
  return JSON.stringify(value);
}

const XAiPromptCompleteNotification = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  agentResult: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

type XAiPromptCompleteNotification = typeof XAiPromptCompleteNotification.Type;

interface PendingXAiPromptCompletion {
  readonly sessionId: string;
  readonly promptId: string;
  readonly deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>;
}

const completedXAiPromptIdLimit = 128;
const defaultSessionLoadTimeout = Duration.seconds(90);
const defaultSessionLoadReplayIdleGap = Duration.seconds(2);
const xAiStopReasonMissingMetaKey = "xAiStopReasonMissing";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly sessionLoadTimeout?: Duration.Input;
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
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
     * Initializes the ACP connection, authenticates, and loads, resumes, or creates the session.
     * Concurrent calls share the same in-flight startup and a failed startup may be retried.
     */
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    /** Stream of parsed ACP session events emitted after startup. */
    readonly getEvents: () => Stream.Stream<AcpParsedSessionEvent, never>;
    /** Latest mode state observed from session setup and `session/update` notifications. */
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    /** Latest configuration options observed from session setup and configuration writes. */
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    /**
     * Sends a prompt turn to the active session.
     * @see https://agentclientprotocol.com/protocol/schema#session/prompt
     */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
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

export const make = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());
    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const startStateRef = yield* Ref.make<AcpStartState>({ _tag: "NotStarted" });
    const promptSerializationSemaphore = yield* Semaphore.make(1);
    const activePromptFiberRef = yield* Ref.make<
      Option.Option<Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>>
    >(Option.none());
    const pendingXAiPromptCompletionsRef = yield* Ref.make<
      ReadonlyArray<PendingXAiPromptCompletion>
    >([]);
    const completedXAiPromptIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());
    let nextXAiPromptFallbackId = 0;
    const allocateXAiPromptFallbackId = Effect.sync(() => {
      nextXAiPromptFallbackId += 1;
      return `t3-xai-prompt-${nextXAiPromptFallbackId}`;
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
          effect.pipe(
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

    const spawnCommand = yield* resolveSpawnCommand(
      options.spawn.command,
      options.spawn.args,
      options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {},
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {}),
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

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
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

    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const gate = yield* Ref.get(sessionLoadGateRef);
        if (Option.isSome(gate) && gate.value.active) {
          const lastActivityAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              ...gate.value,
              lastActivityAtMillis,
            }),
          );
          return;
        }
        if (sessionUpdateIsReplay(notification)) {
          return;
        }
        yield* handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          params: notification,
        });
      }),
    );
    yield* acp.handleExtNotification(
      "_x.ai/session/prompt_complete",
      XAiPromptCompleteNotification,
      (notification) =>
        resolveXAiPromptCompletionFallback({
          pendingRef: pendingXAiPromptCompletionsRef,
          completedPromptIdsRef: completedXAiPromptIdsRef,
          notification,
        }),
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

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

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

    const startOnce = Effect.gen(function* () {
      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: initializeClientCapabilities,
        clientInfo: options.clientInfo,
      } satisfies EffectAcpSchema.InitializeRequest;

      const initializeResult = yield* runLoggedRequest(
        "initialize",
        initializePayload,
        acp.agent.initialize(initializePayload),
      );

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
      if (options.resumeSessionId) {
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
                  Ref.set(startStateRef, { _tag: "Started", result }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, result)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies AcpStartState,
            ] as const;
        }
      });
      return yield* effect;
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
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      prompt: (payload) =>
        promptSerializationSemaphore.withPermit(
          Effect.gen(function* () {
            const started = yield* getStartedState;
            const promptId = yield* allocateXAiPromptFallbackId;
            yield* closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            });
            const fallback = yield* registerXAiPromptCompletionFallback(
              pendingXAiPromptCompletionsRef,
              started.sessionId,
              promptId,
            );
            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
              _meta: {
                ...payload._meta,
                promptId: fallback.promptId,
                requestId: fallback.promptId,
              },
            } satisfies EffectAcpSchema.PromptRequest;
            const cancelledResponse = promptResponseFromXAi({
              sessionId: started.sessionId,
              promptId: fallback.promptId,
              stopReason: "cancelled",
              agentResult: null,
            });
            // Grok can emit its private prompt-complete notification even when the
            // standard session/prompt RPC never settles. Race the RPC with that
            // notification so callers still emit turn completion and clear UI state.
            const promptRpcFiber = yield* runLoggedRequest(
              "session/prompt",
              requestPayload,
              acp.agent.prompt(requestPayload),
            ).pipe(Effect.forkIn(runtimeScope));
            yield* Ref.set(activePromptFiberRef, Option.some(promptRpcFiber));
            return yield* Effect.raceFirst(
              Fiber.join(promptRpcFiber).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.succeed(cancelledResponse)
                    : Effect.failCause(cause),
                ),
              ),
              Deferred.await(fallback.deferred),
            ).pipe(
              Effect.tap((response) =>
                rememberCompletedXAiPromptId(completedXAiPromptIdsRef, response, fallback.promptId),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
                  yield* unregisterXAiPromptCompletionFallback(
                    pendingXAiPromptCompletionsRef,
                    fallback.deferred,
                  );
                  yield* Ref.set(activePromptFiberRef, Option.none());
                }),
              ),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  queue: eventQueue,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) =>
          Effect.gen(function* () {
            const activePromptFiber = yield* Ref.get(activePromptFiberRef);
            if (Option.isSome(activePromptFiber)) {
              yield* Fiber.interrupt(activePromptFiber.value).pipe(Effect.ignore);
            }
            yield* abortPendingPromptCompletions(pendingXAiPromptCompletionsRef, started.sessionId);
            yield* acp.agent
              .cancel({ sessionId: started.sessionId })
              .pipe(Effect.ignore, Effect.forkIn(runtimeScope));
          }),
        ),
      ),
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
      setSessionModel: (modelId) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              modelId,
            } satisfies EffectAcpSchema.SetSessionModelRequest;
            return runLoggedRequest(
              "session/set_model",
              requestPayload,
              acp.agent.setSessionModel(requestPayload),
            );
          }),
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntime["Service"];
  });

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
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

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  assistantSegmentRef,
  params,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
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
        const { previous, merged } = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [{ previous, merged: nextToolCall }, next] as const;
        });
        if (!shouldEmitToolCallUpdate(previous, merged)) {
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

function shouldEmitToolCallUpdate(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") {
    return true;
  }
  if (!next.detail) {
    return false;
  }
  return previous === undefined || previous.title !== next.title || previous.detail !== next.detail;
}

const assistantItemId = (sessionId: string, segmentIndex: number) =>
  `assistant:${sessionId}:segment:${segmentIndex}`;

const ensureActiveAssistantSegment = ({
  queue,
  assistantSegmentRef,
  sessionId,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly assistantSegmentRef: Ref.Ref<AcpAssistantSegmentState>;
  readonly sessionId: string;
}) =>
  Ref.modify<AcpAssistantSegmentState, EnsureActiveAssistantSegmentResult>(
    assistantSegmentRef,
    (current) => {
      if (current.activeItemId) {
        return [{ itemId: current.activeItemId }, current] as const;
      }
      const itemId = assistantItemId(sessionId, current.nextSegmentIndex);
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
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
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

const registerXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
  promptId: string,
) =>
  Deferred.make<EffectAcpSchema.PromptResponse>().pipe(
    Effect.tap((deferred) =>
      Ref.update(pendingRef, (pending) => [...pending, { sessionId, promptId, deferred }]),
    ),
    Effect.map((deferred) => ({ deferred, promptId })),
  );

const unregisterXAiPromptCompletionFallback = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>,
) => Ref.update(pendingRef, (pending) => pending.filter((entry) => entry.deferred !== deferred));

const abortPendingPromptCompletions = (
  pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>,
  sessionId: string,
) =>
  Ref.modify(pendingRef, (pending) => {
    const [toAbort, remaining] = pending.reduce<
      [ReadonlyArray<PendingXAiPromptCompletion>, ReadonlyArray<PendingXAiPromptCompletion>]
    >(
      ([aborting, kept], entry) =>
        entry.sessionId === sessionId ? [[...aborting, entry], kept] : [aborting, [...kept, entry]],
      [[], []],
    );
    if (toAbort.length === 0) {
      return [Effect.void, pending] as const;
    }
    return [
      Effect.forEach(
        toAbort,
        (entry) =>
          Deferred.succeed(
            entry.deferred,
            promptResponseFromXAi({
              sessionId: entry.sessionId,
              promptId: entry.promptId,
              stopReason: "cancelled",
              agentResult: null,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
      remaining,
    ] as const;
  }).pipe(Effect.flatten);

const resolveXAiPromptCompletionFallback = ({
  pendingRef,
  completedPromptIdsRef,
  notification,
}: {
  readonly pendingRef: Ref.Ref<ReadonlyArray<PendingXAiPromptCompletion>>;
  readonly completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>;
  readonly notification: XAiPromptCompleteNotification;
}) =>
  Ref.get(completedPromptIdsRef).pipe(
    Effect.flatMap((completedPromptIds) => {
      if (
        notification.promptId !== undefined &&
        completedPromptIds.includes(notification.promptId)
      ) {
        return Effect.void;
      }
      return Ref.modify(pendingRef, (pending) => {
        const index =
          notification.promptId !== undefined
            ? pending.findIndex(
                (entry) =>
                  entry.sessionId === notification.sessionId &&
                  entry.promptId === notification.promptId,
              )
            : (() => {
                const sessionPendingIndexes = pending.flatMap((entry, entryIndex) =>
                  entry.sessionId === notification.sessionId ? [entryIndex] : [],
                );
                if (sessionPendingIndexes.length === 0) {
                  return -1;
                }
                // xAI may omit promptId while multiple steered prompts are in flight.
                // Resolve the oldest pending fallback FIFO for this session.
                return sessionPendingIndexes[0] ?? -1;
              })();
        if (index < 0) {
          return [Effect.void, pending] as const;
        }
        const entry = pending[index];
        if (!entry) {
          return [Effect.void, pending] as const;
        }
        return [
          Deferred.succeed(entry.deferred, promptResponseFromXAi(notification)).pipe(Effect.asVoid),
          [...pending.slice(0, index), ...pending.slice(index + 1)],
        ] as const;
      }).pipe(Effect.flatten);
    }),
  );

const rememberCompletedXAiPromptId = (
  completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>,
  response: EffectAcpSchema.PromptResponse,
  fallbackPromptId: string,
) => {
  const promptId = promptIdFromResponse(response) ?? fallbackPromptId;
  if (promptId.length === 0) {
    return Effect.void;
  }
  return Ref.update(completedPromptIdsRef, (completedPromptIds) => {
    if (completedPromptIds.includes(promptId)) {
      return completedPromptIds;
    }
    return [...completedPromptIds, promptId].slice(-completedXAiPromptIdLimit);
  });
};

function promptIdFromResponse(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = response._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

export function promptResponseHasMissingXAiStopReason(
  response: EffectAcpSchema.PromptResponse,
): boolean {
  const meta = response._meta;
  return meta !== null && typeof meta === "object" && meta[xAiStopReasonMissingMetaKey] === true;
}

function promptResponseFromXAi(
  notification: XAiPromptCompleteNotification,
): EffectAcpSchema.PromptResponse {
  const stopReason = normalizeXAiStopReason(notification.stopReason);
  const meta: Record<string, unknown> = {
    sessionId: notification.sessionId,
  };
  if (notification.stopReason === undefined) {
    meta[xAiStopReasonMissingMetaKey] = true;
  }
  if (notification.promptId !== undefined) {
    meta.promptId = notification.promptId;
    meta.requestId = notification.promptId;
  }
  if (notification.agentResult !== undefined) {
    meta.agentResult = notification.agentResult;
  }
  return {
    stopReason,
    _meta: meta,
  };
}

function normalizeXAiStopReason(value: string | undefined): EffectAcpSchema.StopReason {
  switch (value) {
    case "cancelled":
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return value;
    default:
      return "end_turn";
  }
}
