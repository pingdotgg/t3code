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
import { sessionConfigOptionsFromSetup } from "./acpSessionRuntimeSupport.ts";
import type { AcpInitializeState, AcpStartState, AcpStartedState } from "./acpSessionRuntimeSupport.ts";
import type {
  AcpSessionActivationOptions,
  AcpSessionRuntimeOptions,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntime.ts";
import type { AcpSessionRuntimeState } from "./acpSessionRuntimeSupport.ts";
import { isAcpAuthenticationRequired } from "./acpSessionRuntimeSupport.ts";
import { selectAcpAgentAuthMethod } from "./acpSessionRuntimeSupport.ts";

export interface MakeAcpSessionStartPhaseDeps {
  readonly state: AcpSessionRuntimeState;
  readonly acp: Parameters<typeof EffectAcpClient.AcpClient.of>[0];
  readonly ensureConnected: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly initializeClientCapabilities: NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;
  readonly processSessionUpdate: (notification: EffectAcpSchema.SessionNotification) => Effect.Effect<void, never, never>;
  readonly runLoggedRequest: <A>(method: string, payload: unknown, effect: Effect.Effect<A, EffectAcpErrors.AcpError>) => Effect.Effect<A, EffectAcpErrors.AcpError>;
  readonly runLoadSessionWithReplayIdle: (loadPayload: EffectAcpSchema.LoadSessionRequest, initializeResult: EffectAcpSchema.InitializeResponse) => Effect.Effect<EffectAcpSchema.LoadSessionResponse, EffectAcpErrors.AcpError>;
  readonly options: AcpSessionRuntimeOptions;
}

export const makeAcpSessionStartPhase = Effect.fn("makeAcpSessionStartPhase")(function* (
  deps: MakeAcpSessionStartPhaseDeps,
) {
  const {
    configOptionsRef,
    initializeStateRef,
    modeStateRef,
    notificationSemaphore,
    startStateRef,
    startupMetadataRef,
    terminationErrorRef,
  } = deps.state;
  const { acp, ensureConnected, initializeClientCapabilities, processSessionUpdate, runLoggedRequest, runLoadSessionWithReplayIdle, options } = deps;

  const initializeOnce = Effect.gen(function* () {
    const initializePayload = {
      protocolVersion: 2,
      clientCapabilities: initializeClientCapabilities,
      clientInfo: options.clientInfo,
      ...(options.initializeMeta === undefined ? {} : { _meta: options.initializeMeta }),
    } satisfies EffectAcpSchema.InitializeRequest;

    const initializeResult = yield* runLoggedRequest(
      "initialize",
      initializePayload,
      acp.agent.initialize(initializePayload),
    );
    yield* options.onInitialized?.(initializeResult) ?? Effect.void;
    return initializeResult;
  });

  const initialize = Effect.gen(function* () {
    yield* ensureConnected;
    const deferred = yield* Deferred.make<
      EffectAcpSchema.InitializeResponse,
      EffectAcpErrors.AcpError
    >();
    const effect = yield* Ref.modify(initializeStateRef, (state) => {
      switch (state._tag) {
        case "Started":
          return [Effect.succeed(state.result), state] as const;
        case "Starting":
          return [Deferred.await(state.deferred), state] as const;
        case "NotStarted":
          return [
            initializeOnce.pipe(
              Effect.tap((result) =>
                Ref.set(initializeStateRef, { _tag: "Started", result }).pipe(
                  Effect.andThen(Deferred.succeed(deferred, result)),
                ),
              ),
              Effect.onError((cause) =>
                Deferred.failCause(deferred, cause).pipe(
                  Effect.andThen(Ref.set(initializeStateRef, { _tag: "NotStarted" })),
                ),
              ),
            ),
            { _tag: "Starting", deferred } satisfies AcpInitializeState,
          ] as const;
      }
    });
    return yield* effect;
  });

  const sessionMcpServers = (
    initializeResult: EffectAcpSchema.InitializeResponse,
    activationOptions?: AcpSessionActivationOptions,
  ): ReadonlyArray<EffectAcpSchema.McpServer> => {
    const mcpCapabilities = initializeResult.agentCapabilities?.mcpCapabilities;
    const acpServers = activationOptions?.acpMcpServers ?? options.acpMcpServers ?? [];
    if (mcpCapabilities?.acp === true && acpServers.length > 0) {
      return acpServers;
    }
    const httpServers = activationOptions?.httpMcpServers ?? options.httpMcpServers ?? [];
    if (mcpCapabilities?.http === true && httpServers.length > 0) {
      return httpServers;
    }
    return activationOptions?.mcpServers ?? options.mcpServers ?? [];
  };

  const sessionSetupFields = (initializeResult: EffectAcpSchema.InitializeResponse) => {
    const meta = options.sessionMeta?.(initializeResult);
    return {
      ...(options.additionalDirectories?.length
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      ...(meta == null ? {} : { _meta: meta }),
    };
  };

  const startOnce = Effect.gen(function* () {
    const initializeResult = yield* initialize;

    const authenticateAfterRequired = Effect.fn("AcpSessionRuntime.authenticateAfterRequired")(
      function* (
        authRequiredError: EffectAcpErrors.AcpError,
      ): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
        const configuredAuthMethodId = options.authMethodId?.trim();
        const authMethod = selectAcpAgentAuthMethod(
          initializeResult.authMethods,
          configuredAuthMethodId,
        );
        if (
          configuredAuthMethodId &&
          initializeResult.authMethods !== undefined &&
          authMethod === undefined
        ) {
          return yield* new EffectAcpErrors.AcpTransportError({
            detail: `ACP agent did not advertise configured authentication method "${configuredAuthMethodId}"`,
            cause: { configuredAuthMethodId, authMethods: initializeResult.authMethods },
          });
        }
        if (
          authMethod !== undefined &&
          authMethod.type !== undefined &&
          authMethod.type !== "agent"
        ) {
          return yield* new EffectAcpErrors.AcpTransportError({
            detail: `ACP authentication method "${authMethod.id}" requires ${authMethod.type} authentication, which cannot run inside a headless provider session`,
            cause: authMethod,
          });
        }

        const authMethodId = authMethod?.id ?? configuredAuthMethodId;
        if (!authMethodId) {
          return yield* authRequiredError;
        }

        const authenticatePayload = {
          methodId: authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;
        yield* runLoggedRequest(
          "authenticate",
          authenticatePayload,
          acp.agent.authenticate(authenticatePayload),
        );
      },
    );

    const setupSession = Effect.gen(function* () {
      let sessionId: string;
      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;
      const additionalDirectories = sessionSetupFields(initializeResult);
      if (options.resumeSessionId) {
        sessionId = options.resumeSessionId;
        if (
          initializeResult.agentCapabilities?.loadSession === true &&
          options.resumeMethod !== "resume"
        ) {
          const loadPayload = {
            sessionId,
            cwd: options.cwd,
            ...additionalDirectories,
            mcpServers: sessionMcpServers(initializeResult),
          } satisfies EffectAcpSchema.LoadSessionRequest;
          sessionSetupResult = yield* runLoadSessionWithReplayIdle(loadPayload, initializeResult);
        } else if (initializeResult.agentCapabilities?.sessionCapabilities?.resume != null) {
          const resumePayload = {
            sessionId,
            cwd: options.cwd,
            ...additionalDirectories,
            mcpServers: sessionMcpServers(initializeResult),
          } satisfies EffectAcpSchema.ResumeSessionRequest;
          sessionSetupResult = yield* runLoggedRequest(
            "session/resume",
            resumePayload,
            acp.agent.resumeSession(resumePayload),
          );
        } else {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "ACP agent does not advertise session/load or session/resume support",
          });
        }
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: sessionMcpServers(initializeResult),
          ...additionalDirectories,
        } satisfies EffectAcpSchema.NewSessionRequest;
        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      return { sessionId, sessionSetupResult };
    });

    if (options.authenticateEagerly === true) {
      // The configured method is authoritative here: Antigravity accepts
      // methods (API key, Vertex) it does not list in `initialize`.
      const authenticatePayload = {
        methodId: options.authMethodId ?? "",
      } satisfies EffectAcpSchema.AuthenticateRequest;
      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );
    }
    const { sessionId, sessionSetupResult } = yield* setupSession.pipe(
      Effect.catchIf(
        (error) =>
          !(!isAcpAuthenticationRequired(error) || options.authenticateOnAuthRequired === false),
        (error) => authenticateAfterRequired(error).pipe(Effect.andThen(setupSession)),
      ),
    );

    yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
    yield* SubscriptionRef.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

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
    const deferred = yield* Deferred.make<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>();
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
  return { initialize, start, sessionMcpServers, sessionSetupFields, initializeOnce };
});
