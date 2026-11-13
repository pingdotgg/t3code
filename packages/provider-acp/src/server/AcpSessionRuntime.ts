// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";

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

// Antigravity can emit an accepted 16 KiB Google authorization URL on stderr.

import type { AcpSpawnInput, AcpSessionRuntimeOptions, AcpSessionRequestLogEvent, AcpSessionRuntimeStartResult, AcpSessionActivationOptions } from "./acpSessionRuntimeConfig.ts";
export type { AcpSpawnInput, AcpSessionRuntimeOptions, AcpSessionRequestLogEvent, AcpSessionRuntimeStartResult, AcpSessionActivationOptions } from "./acpSessionRuntimeConfig.ts";

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    readonly handleRequestPermission: EffectAcpClient.AcpClient["Service"]["handleRequestPermission"];
    readonly handleElicitation: EffectAcpClient.AcpClient["Service"]["handleElicitation"];
    readonly handleMcpConnect: EffectAcpClient.AcpClient["Service"]["handleMcpConnect"];
    readonly handleMcpMessage: EffectAcpClient.AcpClient["Service"]["handleMcpMessage"];
    readonly handleMcpDisconnect: EffectAcpClient.AcpClient["Service"]["handleMcpDisconnect"];
    readonly handleMcpNotification: EffectAcpClient.AcpClient["Service"]["handleMcpNotification"];
    readonly handleReadTextFile: EffectAcpClient.AcpClient["Service"]["handleReadTextFile"];
    readonly handleWriteTextFile: EffectAcpClient.AcpClient["Service"]["handleWriteTextFile"];
    readonly handleCreateTerminal: EffectAcpClient.AcpClient["Service"]["handleCreateTerminal"];
    readonly handleTerminalOutput: EffectAcpClient.AcpClient["Service"]["handleTerminalOutput"];
    readonly handleTerminalWaitForExit: EffectAcpClient.AcpClient["Service"]["handleTerminalWaitForExit"];
    readonly handleTerminalKill: EffectAcpClient.AcpClient["Service"]["handleTerminalKill"];
    readonly handleTerminalRelease: EffectAcpClient.AcpClient["Service"]["handleTerminalRelease"];
    readonly handleSessionUpdate: EffectAcpClient.AcpClient["Service"]["handleSessionUpdate"];
    readonly handleElicitationComplete: EffectAcpClient.AcpClient["Service"]["handleElicitationComplete"];
    readonly handleUnknownExtRequest: EffectAcpClient.AcpClient["Service"]["handleUnknownExtRequest"];
    readonly handleUnknownExtNotification: EffectAcpClient.AcpClient["Service"]["handleUnknownExtNotification"];
    readonly handleExtRequest: EffectAcpClient.AcpClient["Service"]["handleExtRequest"];
    readonly handleExtNotification: EffectAcpClient.AcpClient["Service"]["handleExtNotification"];
    /** Reads capabilities without authentication, session creation, or MCP startup. */
    readonly initialize: () => Effect.Effect<
      EffectAcpSchema.InitializeResponse,
      EffectAcpErrors.AcpError
    >;
    readonly authenticate?: (methodId: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly start: () => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly getEvents: () => Stream.Stream<AcpSessionRuntimeEvent, never>;
    readonly drainEvents: Effect.Effect<void>;
    readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
    readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    /** The current configuration options, then each later change. */
    readonly configOptionChanges: Stream.Stream<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
    readonly loadSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly resumeSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly forkSession: (
      sessionId: string,
      options?: AcpSessionActivationOptions,
      meta?: NonNullable<EffectAcpSchema.ForkSessionRequest["_meta"]>,
    ) => Effect.Effect<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    readonly listSessions: (
      cursor?: string,
    ) => Effect.Effect<EffectAcpSchema.ListSessionsResponse, EffectAcpErrors.AcpError>;
    readonly closeSession: (
      sessionId?: string,
    ) => Effect.Effect<EffectAcpSchema.CloseSessionResponse, EffectAcpErrors.AcpError>;
    readonly deleteSession: (
      sessionId: string,
    ) => Effect.Effect<EffectAcpSchema.DeleteSessionResponse, EffectAcpErrors.AcpError>;
    readonly listProviders: Effect.Effect<
      EffectAcpSchema.ListProvidersResponse,
      EffectAcpErrors.AcpError
    >;
    readonly setProvider: (
      provider: EffectAcpSchema.SetProviderRequest,
    ) => Effect.Effect<EffectAcpSchema.SetProviderResponse, EffectAcpErrors.AcpError>;
    readonly disableProvider: (
      providerId: string,
    ) => Effect.Effect<EffectAcpSchema.DisableProviderResponse, EffectAcpErrors.AcpError>;
    readonly logout: Effect.Effect<EffectAcpSchema.LogoutResponse, EffectAcpErrors.AcpError>;
    /** options.dispatched settles when cancel can target this prompt. */
    readonly prompt: (
      payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
      options?: { readonly dispatched?: Deferred.Deferred<void> },
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly terminateProcessGroup?: Effect.Effect<void, AcpProcessGroupTerminationError>;
    readonly setMode: (
      modeId: string,
    ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
    readonly setSessionModel: (
      modelId: string,
      meta?: EffectAcpSchema.SetSessionModelRequest["_meta"],
    ) => Effect.Effect<EffectAcpSchema.SetSessionModelResponse, EffectAcpErrors.AcpError>;
    /**
     * Writes a session configuration option. A select value the option does
     * not list is refused unless `allowUnlistedValue` is set, for agents that
     * take any value and judge it themselves (a custom model id the agent
     * does not list).
     */
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
      options?: { readonly allowUnlistedValue?: boolean },
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
    readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }
>()("@t3tools/provider-acp/server/AcpSessionRuntime") {}

export const make = Effect.fn("AcpSessionRuntime.make")(function* (
  options: AcpSessionRuntimeOptions,
): Effect.fn.Return<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeScope = yield* Scope.fork(yield* Scope.Scope);
  const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
  const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallTrackedState>());
  const shownToolCallIds = new Set<string>();
  const assistantItemRuntimeId = yield* random.uuidV4().pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to generate an ACP assistant item runtime identifier.",
          cause,
        }),
    ),
  );
  const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
  const configOptionsRef = yield* SubscriptionRef.make(sessionConfigOptionsFromSetup(undefined));
  const initializeStateRef = yield* Ref.make<AcpInitializeState>({ _tag: "NotStarted" });
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
  const stderrTailRef = yield* Ref.make("");
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const stderrDrained = yield* Deferred.make<void>();
  const runtimeClosed = yield* Deferred.make<void>();
  const promptSerializationSemaphore = yield* Semaphore.make(1);
  const sessionLoadSemaphore = yield* Semaphore.make(1);
  const promptDispatchSemaphore = yield* Semaphore.make(1);
  const activePromptRef = yield* Ref.make<Option.Option<AcpActivePrompt>>(Option.none());
  const assistantUpdatesOpenRef = yield* Ref.make(true);
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

  const enrichProcessExitWithStderr = (
    error: EffectAcpErrors.AcpError,
  ): Effect.Effect<EffectAcpErrors.AcpError> =>
    error._tag !== "AcpProcessExitedError" || (error.stderr?.trim().length ?? 0) > 0
      ? Effect.succeed(error)
      : Deferred.await(stderrDrained).pipe(
          Effect.timeout("250 millis"),
          Effect.ignore,
          Effect.andThen(Ref.get(stderrTailRef)),
          Effect.map((tail) => {
            const stderr = sanitizeAcpStderrExcerpt(tail, homeDirectory);
            return stderr.length === 0
              ? error
              : new EffectAcpErrors.AcpProcessExitedError({
                  ...(error.code !== undefined ? { code: error.code } : {}),
                  ...(error.signal !== undefined ? { signal: error.signal } : {}),
                  ...(error.pid !== undefined ? { pid: error.pid } : {}),
                  stderr,
                  ...(error.cause !== undefined ? { cause: error.cause } : {}),
                });
          }),
        );

  const recordTermination = Effect.fn("AcpSessionRuntime.recordTermination")(function* (
    error: EffectAcpErrors.AcpError,
  ) {
    if (yield* Ref.get(stoppingRef)) {
      return;
    }
    const enriched = yield* enrichProcessExitWithStderr(error);
    const firstTermination = yield* Ref.modify(terminationErrorRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some(enriched)] as const),
    );
    if (!firstTermination) {
      return;
    }
    yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
    yield* Queue.offer(eventQueue, { _tag: "ConnectionTerminated", error: enriched });
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
        (options.onStderr ? Effect.raceFirst(effect, Deferred.await(stderrFailure)) : effect).pipe(
          Effect.catch((error) =>
            enrichProcessExitWithStderr(error).pipe(Effect.flatMap(Effect.fail)),
          ),
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

  const { child, stopScope, terminateProcessGroup, posixController, linuxCgroupLease, signalOwnedProcessGroup, terminatePosixProcessTree } = yield* makeAcpSpawnContainment({ options, recordTermination, runtimeScope, spawner, stderrDrained, stderrFailure, stderrTailRef });
  const acpContext = yield* Layer.build(
    EffectAcpClient.layerChildProcess(child, {
      ...(options.transformStdout ? { transformStdout: options.transformStdout } : {}),
      ...(options.transformSessionUpdate
        ? { transformSessionUpdate: options.transformSessionUpdate }
        : {}),
      ...(options.protocolLogging?.logIncoming !== undefined
        ? { logIncoming: options.protocolLogging.logIncoming }
        : {}),
      ...(options.protocolLogging?.logOutgoing !== undefined
        ? { logOutgoing: options.protocolLogging.logOutgoing }
        : {}),
      ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
      onTermination: (error) =>
        recordTermination(error).pipe(
          Effect.andThen(options.onTermination?.(error) ?? Effect.void),
          Effect.ensuring(
            Scope.close(runtimeScope, Exit.fail(error)).pipe(Effect.forkDetach, Effect.asVoid),
          ),
        ),
      ...(options.onOutgoingResponseFailure
        ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
        : {}),
      ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
    }),
  ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

  const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

  // Counts applied `config_option_update`s; see setConfigOption.
  const configOptionUpdates = yield* Ref.make(0);

  const state: AcpSessionRuntimeState = {
    runtimeScope,
    eventQueue,
    modeStateRef,
    toolCallsRef,
    shownToolCallIds,
    assistantItemRuntimeId,
    assistantSegmentRef,
    configOptionsRef,
    initializeStateRef,
    startStateRef,
    startupMetadataRef,
    notificationSemaphore,
    terminationErrorRef,
    stoppingRef,
    stderrFailure,
    stderrTailRef,
    stderrDrained,
    runtimeClosed,
    promptSerializationSemaphore,
    sessionLoadSemaphore,
    promptDispatchSemaphore,
    activePromptRef,
    assistantUpdatesOpenRef,
    sessionLoadGateRef,
    configOptionUpdates,
  };
  const { processSessionUpdate } = yield* makeAcpSessionUpdatePhase({ state, acp });
  const initializeClientCapabilities = {
    fs: {
      readTextFile: false,
      writeTextFile: false,
      ...options.clientCapabilities?.fs,
    },
    terminal: options.clientCapabilities?.terminal ?? false,
    // ACP v1 agents send session notices only to clients that advertise them; v2 needs no capability.
    session: { ...options.clientCapabilities?.session, notices: {} },
    ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
    ...(options.clientCapabilities?.elicitation
      ? { elicitation: options.clientCapabilities.elicitation }
      : {}),
    ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
  } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

  const { getStartedState, validateConfigOptionValue, updateConfigOptions, updateCurrentModeId, adoptSession, runLoadSessionWithReplayIdle, setConfigOption } = yield* makeAcpSessionConfigPhase({ state, acp, ensureConnected, logRequest, options, runLoggedRequest });
  const { initialize, start, sessionMcpServers, sessionSetupFields, initializeOnce } = yield* makeAcpSessionStartPhase({ state, acp, ensureConnected, initializeClientCapabilities, processSessionUpdate, runLoggedRequest, runLoadSessionWithReplayIdle, options });
  const { drainEvents, retireRuntime, cancel } = yield* makeAcpSessionCancelPhase({ options, state, acp, adoptSession, getStartedState, initialize, recordTermination, child });
  return {
    handleRequestPermission: acp.handleRequestPermission,
    handleElicitation: acp.handleElicitation,
    handleMcpConnect: acp.handleMcpConnect,
    handleMcpMessage: acp.handleMcpMessage,
    handleMcpDisconnect: acp.handleMcpDisconnect,
    handleMcpNotification: acp.handleMcpNotification,
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
    initialize: () => initialize,
    authenticate: (methodId) =>
      initialize.pipe(
        Effect.andThen(
          runLoggedRequest("authenticate", { methodId }, acp.agent.authenticate({ methodId })),
        ),
        Effect.asVoid,
      ),
    start: () => start,
    getEvents: () => Stream.fromQueue(eventQueue),
    drainEvents,
    getModeState: Ref.get(modeStateRef),
    getConfigOptions: SubscriptionRef.get(configOptionsRef),
    configOptionChanges: SubscriptionRef.changes(configOptionsRef),
    loadSession: (sessionId, activationOptions) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
          } satisfies EffectAcpSchema.LoadSessionRequest;
          return runLoadSessionWithReplayIdle(requestPayload, started.initializeResult);
        }),
        Effect.flatMap((response) => adoptSession(sessionId, response)),
      ),
    resumeSession: (sessionId, activationOptions) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
          } satisfies EffectAcpSchema.ResumeSessionRequest;
          return runLoggedRequest(
            "session/resume",
            requestPayload,
            acp.agent.resumeSession(requestPayload),
          );
        }),
        Effect.flatMap((response) => adoptSession(sessionId, response)),
      ),
    forkSession: (sessionId, activationOptions, meta) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId,
            cwd: options.cwd,
            ...sessionSetupFields(started.initializeResult),
            mcpServers: sessionMcpServers(started.initializeResult, activationOptions),
            ...(meta === undefined ? {} : { _meta: meta }),
          } satisfies EffectAcpSchema.ForkSessionRequest;
          return runLoggedRequest(
            "session/fork",
            requestPayload,
            acp.agent.forkSession(requestPayload),
          );
        }),
        Effect.flatMap((response) => adoptSession(response.sessionId, response)),
      ),
    listSessions: (cursor) => {
      const requestPayload = {
        cwd: options.cwd,
        ...(cursor === undefined ? {} : { cursor }),
      } satisfies EffectAcpSchema.ListSessionsRequest;
      return initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.sessionCapabilities?.list != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise session/list support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("session/list", requestPayload, acp.agent.listSessions(requestPayload)),
        ),
      );
    },
    closeSession: (sessionId) =>
      start.pipe(
        Effect.flatMap((started) => {
          const requestPayload = {
            sessionId: sessionId ?? started.sessionId,
          } satisfies EffectAcpSchema.CloseSessionRequest;
          return runLoggedRequest(
            "session/close",
            requestPayload,
            acp.agent.closeSession(requestPayload),
          );
        }),
      ),
    deleteSession: (sessionId) =>
      initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.sessionCapabilities?.delete != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise session/delete support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("session/delete", { sessionId }, acp.agent.deleteSession({ sessionId })),
        ),
      ),
    listProviders: initialize.pipe(
      Effect.filterOrFail(
        (initialized) => initialized.agentCapabilities?.providers != null,
        () =>
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise provider configuration support",
          }),
      ),
      Effect.andThen(runLoggedRequest("providers/list", {}, acp.agent.listProviders({}))),
    ),
    setProvider: (provider) =>
      initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.providers != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise provider configuration support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest(
            "providers/set",
            {
              ...provider,
              ...(provider.headers === undefined
                ? {}
                : {
                    headers: Object.fromEntries(
                      Object.keys(provider.headers).map((name) => [name, "[redacted]"]),
                    ),
                  }),
            },
            acp.agent.setProvider(provider),
          ),
        ),
      ),
    disableProvider: (providerId) => {
      const request = { providerId } satisfies EffectAcpSchema.DisableProviderRequest;
      return initialize.pipe(
        Effect.filterOrFail(
          (initialized) => initialized.agentCapabilities?.providers != null,
          () =>
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "ACP agent does not advertise provider configuration support",
            }),
        ),
        Effect.andThen(
          runLoggedRequest("providers/disable", request, acp.agent.disableProvider(request)),
        ),
      );
    },
    logout: initialize.pipe(
      Effect.filterOrFail(
        (initialized) => initialized.agentCapabilities?.auth?.logout != null,
        () =>
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise logout support",
          }),
      ),
      Effect.andThen(runLoggedRequest("logout", {}, acp.agent.logout({}))),
    ),
    prompt: (payload, promptOptions?) =>
      promptSerializationSemaphore.withPermit(
        Effect.acquireUseRelease(
          promptDispatchSemaphore.withPermit(
            Effect.gen(function* () {
              const started = yield* getStartedState;
              yield* closeActiveAssistantSegment({ queue: eventQueue, assistantSegmentRef });
              yield* Ref.set(assistantUpdatesOpenRef, true);
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
            }).pipe(notificationSemaphore.withPermit),
          ),
          (activePrompt) =>
            Fiber.join(activePrompt.fiber).pipe(
              Effect.catchCauseIf(
                (cause) =>
                  options.cancelBehavior !== "wait-for-prompt" && Cause.hasInterruptsOnly(cause),
                (_cause) =>
                  Effect.succeed({
                    stopReason: "cancelled",
                  } satisfies EffectAcpSchema.PromptResponse),
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
    ...(options.ownDetachedProcessGroup === true ? { terminateProcessGroup } : {}),
    // A session's mode is its `category: "mode"` config option. ACP v1 agents
    // that only advertise `modes` (gemini-cli) take `session/set_mode`
    // instead, which ACP v2 removed.
    setMode: Effect.fn("AcpSessionRuntime.setMode")(function* (modeId) {
      const modeState = yield* Ref.get(modeStateRef);
      if (modeState?.currentModeId === modeId) {
        return {} satisfies EffectAcpSchema.SetSessionModeResponse;
      }
      const modeConfigOption = (yield* SubscriptionRef.get(configOptionsRef))?.find(
        (option) => option.category === "mode" && option.type === "select",
      );
      if (modeConfigOption === undefined && modeState !== undefined) {
        const started = yield* getStartedState;
        const payload = { sessionId: started.sessionId, modeId };
        yield* runLoggedRequest("session/set_mode", payload, acp.agent.setSessionMode(payload));
        yield* updateCurrentModeId(modeId);
        return {} satisfies EffectAcpSchema.SetSessionModeResponse;
      }
      const response = yield* setConfigOption(modeConfigOption?.id ?? "mode", modeId);
      const reported = parseSessionModeState({ configOptions: response.configOptions });
      if (reported === undefined) {
        yield* updateCurrentModeId(modeId);
      } else {
        yield* updateCurrentModeId(reported.currentModeId);
      }
      return {} satisfies EffectAcpSchema.SetSessionModeResponse;
    }),
    setSessionModel: (modelId, meta) =>
      getStartedState.pipe(
        Effect.flatMap((started) => {
          const payload = {
            sessionId: started.sessionId,
            modelId,
            ...(meta === undefined ? {} : { _meta: meta }),
          };
          return runLoggedRequest("session/set_model", payload, acp.agent.setSessionModel(payload));
        }),
      ),
    setConfigOption,
    setModel: (model) =>
      getStartedState.pipe(
        Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
        Effect.asVoid,
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
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> => Layer.effect(AcpSessionRuntime, make(options));

import { sessionConfigOptionsFromSetup, configOptionCurrentValueMatches, isStartupMetadataUpdate, handleSessionUpdate, updateModeState, assistantItemId, ensureActiveAssistantSegment, closeActiveAssistantSegment } from "./acpSessionRuntimeSupport.ts";

import { isAcpProcessGroupTerminationError, decodeMountInfoPath, parseUnifiedCgroupPath, isSafeCgroupPath, parseCgroup2Mounts, wrapCommandForLinuxCgroup, resolveLinuxCgroupTargetCommand, STALE_ACP_CGROUP_SIBLING, defaultCgroupOwnerIsAlive, defaultReadCgroupPopulated, sweepStaleLinuxCgroupSiblings, tryCreateLinuxCgroupLease, makeLinuxCgroupController, AcpProcessGroupTerminationError } from "./acpLinuxCgroup.ts";
export { isAcpProcessGroupTerminationError, decodeMountInfoPath, parseUnifiedCgroupPath, isSafeCgroupPath, parseCgroup2Mounts, wrapCommandForLinuxCgroup, resolveLinuxCgroupTargetCommand, STALE_ACP_CGROUP_SIBLING, defaultCgroupOwnerIsAlive, defaultReadCgroupPopulated, sweepStaleLinuxCgroupSiblings, tryCreateLinuxCgroupLease, makeLinuxCgroupController, AcpProcessGroupTerminationError } from "./acpLinuxCgroup.ts";
import {
  MAX_SHOWN_TOOL_CALL_IDS,
  type AcpActivePrompt,
  type AcpAssistantSegmentState,
  type AcpInitializeState,
  type AcpSessionRuntimeState,
  type AcpStartState,
  type AcpStartedState,
  type AcpToolCallTrackedState,
  type EnsureActiveAssistantSegmentResult,
} from "./acpSessionRuntimeSupport.ts";
import { makeAcpSpawnContainment } from "./acpSpawnContainment.ts";
import { makeAcpSessionConfigPhase } from "./acpSessionConfigPhase.ts";
import { makeAcpSessionStartPhase } from "./acpSessionStartPhase.ts";
import { makeAcpSessionCancelPhase } from "./acpSessionCancelPhase.ts";
import { makeAcpSessionUpdatePhase } from "./acpSessionUpdatePhase.ts";
import type { AcpOwnedPosixProcess, AcpPosixProcessIdentity, AcpPosixProcessTreeController, AcpLinuxCgroupLease, AcpLinuxCgroupController, AcpPosixOwnershipRoot, SweepStaleLinuxCgroupSiblingsOptions } from "./acpLinuxCgroup.ts";
export type { AcpPosixProcessIdentity, AcpPosixProcessTreeController, AcpLinuxCgroupLease, AcpLinuxCgroupController, AcpPosixOwnershipRoot, SweepStaleLinuxCgroupSiblingsOptions , AcpOwnedPosixProcess } from "./acpLinuxCgroup.ts";
import { wallClock, withWallClock, terminateLinuxCgroupLease, signalLinuxCgroupRootTerm, readLinuxProcessIdentity, posixProcessIsZombie, readLinuxChildPids, makeLinuxProcessTreeController, observePosixOwnershipLedger, observePosixOwnershipLedgerContinuously, makePosixProcessTreeController, samePosixProcessIdentity, processIdentityKey, processDepth, capturePosixOwnershipLedger, terminatePosixOwnedProcessTree, windowsTaskkillResultIsSuccess, terminateWindowsProcessTreeWithTaskkill } from "./acpPosixProcessTree.ts";
export { wallClock, withWallClock, terminateLinuxCgroupLease, signalLinuxCgroupRootTerm, readLinuxProcessIdentity, posixProcessIsZombie, readLinuxChildPids, makeLinuxProcessTreeController, observePosixOwnershipLedger, observePosixOwnershipLedgerContinuously, makePosixProcessTreeController, samePosixProcessIdentity, processIdentityKey, processDepth, capturePosixOwnershipLedger, terminatePosixOwnedProcessTree, windowsTaskkillResultIsSuccess, terminateWindowsProcessTreeWithTaskkill } from "./acpPosixProcessTree.ts";
export { sessionConfigOptionsFromSetup, configOptionCurrentValueMatches, isStartupMetadataUpdate, handleSessionUpdate, updateModeState, assistantItemId, ensureActiveAssistantSegment, closeActiveAssistantSegment } from "./acpSessionRuntimeSupport.ts";

export { selectAcpAgentAuthMethod } from "./acpSessionRuntimeSupport.ts";
