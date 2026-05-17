import * as Cause from "effect/Cause";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/schema";

import { trackChildProcess, untrackChildProcess } from "../../acpRegistry/childProcessRegistry.ts";

export interface AcpConnectionSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AcpConnectionRequestLogEvent {
  readonly method: string;
  readonly payload: unknown;
  readonly status: "started" | "succeeded" | "failed";
  readonly result?: unknown;
  readonly cause?: Cause.Cause<EffectAcpErrors.AcpError>;
}

export interface AcpConnectionOptions {
  readonly spawn: AcpConnectionSpawnInput;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly authMethodId?: string;
  readonly requestLogger?: (event: AcpConnectionRequestLogEvent) => Effect.Effect<void, never>;
  readonly protocolLogging?: {
    readonly logIncoming?: boolean;
    readonly logOutgoing?: boolean;
    readonly logger?: (event: EffectAcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  };
}

/**
 * Per-session callback registry. A connection routes incoming requests/notifications to the
 * matching session by `sessionId`. Each callback returns an Effect using only the connection's
 * runtime context (no extra services), matching how the underlying effect-acp handlers are typed.
 */
export interface AcpConnectionSessionHandlers {
  readonly onSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly onRequestPermission?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
  readonly onElicitation?: (
    request: EffectAcpSchema.ElicitationRequest,
  ) => Effect.Effect<EffectAcpSchema.ElicitationResponse, EffectAcpErrors.AcpError>;
  readonly onReadTextFile?: (
    request: EffectAcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError>;
  readonly onWriteTextFile?: (
    request: EffectAcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<EffectAcpSchema.WriteTextFileResponse | void, EffectAcpErrors.AcpError>;
}

export interface AcpConnectionStartResult {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod>;
}

export interface AcpConnectionNewSessionOptions {
  readonly cwd: string;
  readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly resumeSessionId?: string;
  readonly handlers: AcpConnectionSessionHandlers;
}

export interface AcpConnectionNewSessionResult {
  readonly sessionId: string;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
}

export class AcpConnection extends Context.Service<
  AcpConnection,
  {
    readonly start: () => Effect.Effect<AcpConnectionStartResult, EffectAcpErrors.AcpError>;
    readonly authenticate: (methodId: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly newSession: (
      options: AcpConnectionNewSessionOptions,
    ) => Effect.Effect<AcpConnectionNewSessionResult, EffectAcpErrors.AcpError>;
    readonly releaseSession: (sessionId: string) => Effect.Effect<void>;
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    readonly notify: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly prompt: (
      payload: EffectAcpSchema.PromptRequest,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
    readonly cancel: (
      payload: EffectAcpSchema.CancelNotification,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
    readonly setSessionConfigOption: (
      payload: EffectAcpSchema.SetSessionConfigOptionRequest,
    ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  }
>()("t3/provider/acp/AcpConnection") {}

interface StartedState {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod>;
}

type StartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<StartedState, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly state: StartedState };

export const make = (
  options: AcpConnectionOptions,
): Effect.Effect<
  AcpConnection["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const hostPlatform = yield* HostProcessPlatform;
    const startStateRef = yield* Ref.make<StartState>({ _tag: "NotStarted" });
    const sessionHandlersRef = yield* Ref.make(new Map<string, AcpConnectionSessionHandlers>());

    const logRequest = (event: AcpConnectionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A>(
      method: string,
      payload: unknown,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) => logRequest({ method, payload, status: "succeeded", result })),
            Effect.onError((cause) => logRequest({ method, payload, status: "failed", cause })),
          ),
        ),
      );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: hostPlatform === "win32",
          // LAYER 1: spawn as process-group leader on Unix so we can SIGTERM the entire group
          // (including any forks/JVMs the child spawns) when the scope closes. Critical for
          // macOS .app launchers like Junie that fork into a long-lived JVM.
          detached: hostPlatform !== "win32",
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

    // LAYER 1 (continued) + LAYER 2 registration: track this PID and ensure the whole group
    // is killed when the connection scope closes (graceful) OR when the server itself exits
    // (handled by the registry's process-level shutdown hooks).
    const childPid = child.pid as unknown as number | undefined;
    if (typeof childPid === "number" && childPid > 0) {
      trackChildProcess(childPid, hostPlatform);
      yield* Scope.addFinalizer(
        runtimeScope,
        Effect.sync(() => {
          untrackChildProcess(childPid);
          if (hostPlatform === "win32") return;
          try {
            // Negative pid → kill the process group, catches forked JVMs.
            process.kill(-childPid, "SIGTERM");
          } catch {
            // Fall back to single-pid kill if group signal fails (e.g. not a group leader).
            try {
              process.kill(childPid, "SIGTERM");
            } catch {
              // Already gone.
            }
          }
        }),
      );
    }

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

    const getHandlers = (sessionId: string) =>
      Ref.get(sessionHandlersRef).pipe(Effect.map((map) => map.get(sessionId)));

    // Connection-level dispatch: each handler routes by params.sessionId to per-session callbacks.
    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const handlers = yield* getHandlers(notification.sessionId);
        if (!handlers?.onSessionUpdate) return;
        yield* handlers.onSessionUpdate(notification);
      }),
    );

    yield* acp.handleRequestPermission((request) =>
      Effect.gen(function* () {
        const handlers = yield* getHandlers(request.sessionId);
        if (!handlers?.onRequestPermission) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            `No handlers registered for session "${request.sessionId}"`,
            { sessionId: request.sessionId },
          );
        }
        return yield* handlers.onRequestPermission(request);
      }),
    );

    yield* acp.handleElicitation((request) =>
      Effect.gen(function* () {
        const handlers = yield* getHandlers(request.sessionId);
        if (!handlers?.onElicitation) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            `No handlers registered for session "${request.sessionId}"`,
            { sessionId: request.sessionId },
          );
        }
        return yield* handlers.onElicitation(request);
      }),
    );

    yield* acp.handleReadTextFile((request) =>
      Effect.gen(function* () {
        const handlers = yield* getHandlers(request.sessionId);
        if (!handlers?.onReadTextFile) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            `No handlers registered for session "${request.sessionId}"`,
            { sessionId: request.sessionId },
          );
        }
        return yield* handlers.onReadTextFile(request);
      }),
    );

    yield* acp.handleWriteTextFile((request) =>
      Effect.gen(function* () {
        const handlers = yield* getHandlers(request.sessionId);
        if (!handlers?.onWriteTextFile) {
          return yield* EffectAcpErrors.AcpRequestError.invalidParams(
            `No handlers registered for session "${request.sessionId}"`,
            { sessionId: request.sessionId },
          );
        }
        return yield* handlers.onWriteTextFile(request);
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

      if (options.authMethodId) {
        const authPayload = {
          methodId: options.authMethodId,
        } satisfies EffectAcpSchema.AuthenticateRequest;
        yield* runLoggedRequest("authenticate", authPayload, acp.agent.authenticate(authPayload));
      }

      return {
        initializeResult,
        authMethods: initializeResult.authMethods ?? [],
      } satisfies StartedState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<StartedState, EffectAcpErrors.AcpError>();
      const effect = yield* Ref.modify(startStateRef, (state) => {
        switch (state._tag) {
          case "Started":
            return [Effect.succeed(state.state), state] as const;
          case "Starting":
            return [Deferred.await(state.deferred), state] as const;
          case "NotStarted":
            return [
              startOnce.pipe(
                Effect.tap((state) =>
                  Ref.set(startStateRef, { _tag: "Started", state }).pipe(
                    Effect.andThen(Deferred.succeed(deferred, state)),
                  ),
                ),
                Effect.onError((cause) =>
                  Deferred.failCause(deferred, cause).pipe(
                    Effect.andThen(Ref.set(startStateRef, { _tag: "NotStarted" })),
                  ),
                ),
              ),
              { _tag: "Starting", deferred } satisfies StartState,
            ] as const;
        }
      });
      return yield* effect;
    });

    const authenticate = (methodId: string) =>
      runLoggedRequest("authenticate", { methodId }, acp.agent.authenticate({ methodId })).pipe(
        Effect.asVoid,
      );

    const registerSessionHandlers = (sessionId: string, handlers: AcpConnectionSessionHandlers) =>
      Ref.update(sessionHandlersRef, (map) => {
        const next = new Map(map);
        next.set(sessionId, handlers);
        return next;
      });

    const releaseSession = (sessionId: string) =>
      Ref.update(sessionHandlersRef, (map) => {
        if (!map.has(sessionId)) return map;
        const next = new Map(map);
        next.delete(sessionId);
        return next;
      });

    const newSession = (input: AcpConnectionNewSessionOptions) =>
      Effect.gen(function* () {
        yield* start;
        const mcpServers = input.mcpServers ?? [];
        let sessionId: string;
        let sessionSetupResult: AcpConnectionNewSessionResult["sessionSetupResult"];
        if (input.resumeSessionId) {
          const loadPayload = {
            sessionId: input.resumeSessionId,
            cwd: input.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.LoadSessionRequest;
          const loaded = yield* runLoggedRequest(
            "session/load",
            loadPayload,
            acp.agent.loadSession(loadPayload),
          ).pipe(Effect.exit);
          if (Exit.isSuccess(loaded)) {
            sessionId = input.resumeSessionId;
            sessionSetupResult = loaded.value;
          } else {
            const createPayload = {
              cwd: input.cwd,
              mcpServers,
            } satisfies EffectAcpSchema.NewSessionRequest;
            const created = yield* runLoggedRequest(
              "session/new",
              createPayload,
              acp.agent.createSession(createPayload),
            );
            sessionId = created.sessionId;
            sessionSetupResult = created;
          }
        } else {
          const createPayload = {
            cwd: input.cwd,
            mcpServers,
          } satisfies EffectAcpSchema.NewSessionRequest;
          const created = yield* runLoggedRequest(
            "session/new",
            createPayload,
            acp.agent.createSession(createPayload),
          );
          sessionId = created.sessionId;
          sessionSetupResult = created;
        }
        yield* registerSessionHandlers(sessionId, input.handlers);
        return { sessionId, sessionSetupResult } satisfies AcpConnectionNewSessionResult;
      });

    return {
      start: () => start,
      authenticate,
      newSession,
      releaseSession,
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
      prompt: (payload) => runLoggedRequest("session/prompt", payload, acp.agent.prompt(payload)),
      cancel: (payload) => acp.agent.cancel(payload),
      setSessionConfigOption: (payload) =>
        runLoggedRequest(
          "session/set_config_option",
          payload,
          acp.agent.setSessionConfigOption(payload),
        ),
    } satisfies AcpConnection["Service"];
  });

export const layer = (options: AcpConnectionOptions) => Layer.effect(AcpConnection, make(options));
