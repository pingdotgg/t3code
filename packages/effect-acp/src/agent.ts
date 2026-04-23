import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpRpcs from "./rpc.ts";
import {
  callRpc,
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
  runHandler,
} from "./_internal/shared.ts";
import * as AcpTerminal from "./terminal.ts";

export interface AcpAgentOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
}

export interface AcpAgentShape {
  readonly raw: {
    /**
     * Stream of inbound ACP notifications observed on the connection.
     */
    readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
    /**
     * Sends a generic ACP extension request.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly request: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, AcpError.AcpError>;
    /**
     * Sends a generic ACP extension notification.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
  };
  readonly client: {
    /**
     * Requests client permission for an operation.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly requestPermission: (
      payload: AcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
    /**
     * Requests structured user input from the client.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
     */
    readonly elicit: (
      payload: AcpSchema.ElicitationRequest,
    ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
    /**
     * Requests file contents from the client.
     * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
     */
    readonly readTextFile: (
      payload: AcpSchema.ReadTextFileRequest,
    ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
    /**
     * Writes a text file through the client.
     * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
     */
    readonly writeTextFile: (
      payload: AcpSchema.WriteTextFileRequest,
    ) => Effect.Effect<AcpSchema.WriteTextFileResponse, AcpError.AcpError>;
    /**
     * Creates a terminal on the client side.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/create
     */
    readonly createTerminal: (
      payload: AcpSchema.CreateTerminalRequest,
    ) => Effect.Effect<AcpTerminal.AcpTerminal, AcpError.AcpError>;
    /**
     * Sends a `session/update` notification to the client.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly sessionUpdate: (
      payload: AcpSchema.SessionNotification,
    ) => Effect.Effect<void, AcpError.AcpError>;
    /**
     * Sends a `session/elicitation/complete` notification to the client.
     * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
     */
    readonly elicitationComplete: (
      payload: AcpSchema.ElicitationCompleteNotification,
    ) => Effect.Effect<void, AcpError.AcpError>;
    /**
     * Sends an ACP extension request to the client.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly extRequest: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<unknown, AcpError.AcpError>;
    /**
     * Sends an ACP extension notification to the client.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly extNotification: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, AcpError.AcpError>;
  };
  /**
   * Registers a handler for `initialize`.
   * @see https://agentclientprotocol.com/protocol/schema#initialize
   */
  readonly handleInitialize: (
    handler: (
      request: AcpSchema.InitializeRequest,
    ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `authenticate`.
   * @see https://agentclientprotocol.com/protocol/schema#authenticate
   */
  readonly handleAuthenticate: (
    handler: (
      request: AcpSchema.AuthenticateRequest,
    ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleLogout: (
    handler: (
      request: AcpSchema.LogoutRequest,
    ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCreateSession: (
    handler: (
      request: AcpSchema.NewSessionRequest,
    ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleLoadSession: (
    handler: (
      request: AcpSchema.LoadSessionRequest,
    ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleListSessions: (
    handler: (
      request: AcpSchema.ListSessionsRequest,
    ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleForkSession: (
    handler: (
      request: AcpSchema.ForkSessionRequest,
    ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleResumeSession: (
    handler: (
      request: AcpSchema.ResumeSessionRequest,
    ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleCloseSession: (
    handler: (
      request: AcpSchema.CloseSessionRequest,
    ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleSetSessionModel: (
    handler: (
      request: AcpSchema.SetSessionModelRequest,
    ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleSetSessionConfigOption: (
    handler: (
      request: AcpSchema.SetSessionConfigOptionRequest,
    ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handlePrompt: (
    handler: (
      request: AcpSchema.PromptRequest,
    ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `session/cancel`.
   * @see https://agentclientprotocol.com/protocol/schema#session/cancel
   */
  readonly handleCancel: (
    handler: (notification: AcpSchema.CancelNotification) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownExtRequest: (
    handler: (method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownExtNotification: (
    handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleExtRequest: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  readonly handleExtNotification: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
}

export class AcpAgent extends Context.Service<AcpAgent, AcpAgentShape>()("effect-acp/AcpAgent") {}

interface AcpCoreAgentRequestHandlers {
  initialize?: (
    request: AcpSchema.InitializeRequest,
  ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
  authenticate?: (
    request: AcpSchema.AuthenticateRequest,
  ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
  logout?: (
    request: AcpSchema.LogoutRequest,
  ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
  createSession?: (
    request: AcpSchema.NewSessionRequest,
  ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
  loadSession?: (
    request: AcpSchema.LoadSessionRequest,
  ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
  listSessions?: (
    request: AcpSchema.ListSessionsRequest,
  ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
  forkSession?: (
    request: AcpSchema.ForkSessionRequest,
  ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
  resumeSession?: (
    request: AcpSchema.ResumeSessionRequest,
  ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
  closeSession?: (
    request: AcpSchema.CloseSessionRequest,
  ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
  setSessionModel?: (
    request: AcpSchema.SetSessionModelRequest,
  ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
  setSessionConfigOption?: (
    request: AcpSchema.SetSessionConfigOptionRequest,
  ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
  prompt?: (
    request: AcpSchema.PromptRequest,
  ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
}

const decodeCancelNotification = Schema.decodeUnknownEffect(AcpSchema.CancelNotification);

export const make = Effect.fn("effect-acp/AcpAgent.make")(function* (
  stdio: Stdio.Stdio,
  options: AcpAgentOptions = {},
): Effect.fn.Return<AcpAgentShape, never, Scope.Scope> {
  const coreHandlers: AcpCoreAgentRequestHandlers = {};
  const cancelHandlers: Array<
    (notification: AcpSchema.CancelNotification) => Effect.Effect<void, AcpError.AcpError>
  > = [];
  const extRequestHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, AcpError.AcpError>
  >();
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpError.AcpError>
  >();
  let unknownExtRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>)
    | undefined;
  let unknownExtNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>)
    | undefined;

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio,
    serverRequestMethods: new Set(AcpRpcs.AgentRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: (notification) => {
      if (
        notification._tag === "ExtNotification" &&
        notification.method === AGENT_METHODS.session_cancel
      ) {
        return decodeCancelNotification(notification.params).pipe(
          Effect.mapError(
            (error) =>
              new AcpError.AcpProtocolParseError({
                detail: `Invalid ${AGENT_METHODS.session_cancel} notification payload`,
                cause: error,
              }),
          ),
          Effect.flatMap((decoded) =>
            Effect.forEach(cancelHandlers, (handler) => handler(decoded), { discard: true }),
          ),
        );
      }

      if (notification._tag !== "ExtNotification") {
        return Effect.void;
      }

      const handler = extNotificationHandlers.get(notification.method);
      if (handler) {
        return handler(notification.params);
      }
      return unknownExtNotificationHandler
        ? unknownExtNotificationHandler(notification.method, notification.params)
        : Effect.void;
    },
    onExtRequest: (method, params) => {
      const handler = extRequestHandlers.get(method);
      if (handler) {
        return handler(params);
      }
      return unknownExtRequestHandler
        ? unknownExtRequestHandler(method, params)
        : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    },
  });

  const agentHandlerLayer = AcpRpcs.AgentRpcs.toLayer(
    AcpRpcs.AgentRpcs.of({
      [AGENT_METHODS.initialize]: (payload) =>
        runHandler(coreHandlers.initialize, payload, AGENT_METHODS.initialize),
      [AGENT_METHODS.authenticate]: (payload) =>
        runHandler(coreHandlers.authenticate, payload, AGENT_METHODS.authenticate),
      [AGENT_METHODS.logout]: (payload) =>
        runHandler(coreHandlers.logout, payload, AGENT_METHODS.logout),
      [AGENT_METHODS.session_new]: (payload) =>
        runHandler(coreHandlers.createSession, payload, AGENT_METHODS.session_new),
      [AGENT_METHODS.session_load]: (payload) =>
        runHandler(coreHandlers.loadSession, payload, AGENT_METHODS.session_load),
      [AGENT_METHODS.session_list]: (payload) =>
        runHandler(coreHandlers.listSessions, payload, AGENT_METHODS.session_list),
      [AGENT_METHODS.session_fork]: (payload) =>
        runHandler(coreHandlers.forkSession, payload, AGENT_METHODS.session_fork),
      [AGENT_METHODS.session_resume]: (payload) =>
        runHandler(coreHandlers.resumeSession, payload, AGENT_METHODS.session_resume),
      [AGENT_METHODS.session_close]: (payload) =>
        runHandler(coreHandlers.closeSession, payload, AGENT_METHODS.session_close),
      [AGENT_METHODS.session_set_model]: (payload) =>
        runHandler(coreHandlers.setSessionModel, payload, AGENT_METHODS.session_set_model),
      [AGENT_METHODS.session_set_config_option]: (payload) =>
        runHandler(
          coreHandlers.setSessionConfigOption,
          payload,
          AGENT_METHODS.session_set_config_option,
        ),
      [AGENT_METHODS.session_prompt]: (payload) =>
        runHandler(coreHandlers.prompt, payload, AGENT_METHODS.session_prompt),
    }),
  );

  yield* RpcServer.make(AcpRpcs.AgentRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(agentHandlerLayer),
    Effect.forkScoped,
  );

  let nextRpcRequestId = 1n << 32n;
  const rpc = yield* RpcClient.make(AcpRpcs.ClientRpcs, {
    generateRequestId: () => nextRpcRequestId++ as never,
  }).pipe(Effect.provideService(RpcClient.Protocol, transport.clientProtocol));

  return AcpAgent.of({
    raw: {
      notifications: transport.incoming,
      request: transport.request,
      notify: transport.notify,
    },
    client: {
      requestPermission: (payload) =>
        callRpc(rpc[CLIENT_METHODS.session_request_permission](payload)),
      elicit: (payload) => callRpc(rpc[CLIENT_METHODS.session_elicitation](payload)),
      readTextFile: (payload) => callRpc(rpc[CLIENT_METHODS.fs_read_text_file](payload)),
      writeTextFile: (payload) => callRpc(rpc[CLIENT_METHODS.fs_write_text_file](payload)),
      createTerminal: (payload) =>
        callRpc(rpc[CLIENT_METHODS.terminal_create](payload)).pipe(
          Effect.map((response) =>
            AcpTerminal.makeTerminal({
              sessionId: payload.sessionId,
              terminalId: response.terminalId,
              output: callRpc(
                rpc[CLIENT_METHODS.terminal_output]({
                  sessionId: payload.sessionId,
                  terminalId: response.terminalId,
                }),
              ),
              waitForExit: callRpc(
                rpc[CLIENT_METHODS.terminal_wait_for_exit]({
                  sessionId: payload.sessionId,
                  terminalId: response.terminalId,
                }),
              ),
              kill: callRpc(
                rpc[CLIENT_METHODS.terminal_kill]({
                  sessionId: payload.sessionId,
                  terminalId: response.terminalId,
                }),
              ),
              release: callRpc(
                rpc[CLIENT_METHODS.terminal_release]({
                  sessionId: payload.sessionId,
                  terminalId: response.terminalId,
                }),
              ),
            }),
          ),
        ),
      sessionUpdate: (payload) => transport.notify(CLIENT_METHODS.session_update, payload),
      elicitationComplete: (payload) =>
        transport.notify(CLIENT_METHODS.session_elicitation_complete, payload),
      extRequest: transport.request,
      extNotification: transport.notify,
    },
    handleInitialize: (handler) =>
      Effect.suspend(() => {
        coreHandlers.initialize = handler;
        return Effect.void;
      }),
    handleAuthenticate: (handler) =>
      Effect.suspend(() => {
        coreHandlers.authenticate = handler;
        return Effect.void;
      }),
    handleLogout: (handler) =>
      Effect.suspend(() => {
        coreHandlers.logout = handler;
        return Effect.void;
      }),
    handleCreateSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.createSession = handler;
        return Effect.void;
      }),
    handleLoadSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.loadSession = handler;
        return Effect.void;
      }),
    handleListSessions: (handler) =>
      Effect.suspend(() => {
        coreHandlers.listSessions = handler;
        return Effect.void;
      }),
    handleForkSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.forkSession = handler;
        return Effect.void;
      }),
    handleResumeSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.resumeSession = handler;
        return Effect.void;
      }),
    handleCloseSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.closeSession = handler;
        return Effect.void;
      }),
    handleSetSessionModel: (handler) =>
      Effect.suspend(() => {
        coreHandlers.setSessionModel = handler;
        return Effect.void;
      }),
    handleSetSessionConfigOption: (handler) =>
      Effect.suspend(() => {
        coreHandlers.setSessionConfigOption = handler;
        return Effect.void;
      }),
    handlePrompt: (handler) =>
      Effect.suspend(() => {
        coreHandlers.prompt = handler;
        return Effect.void;
      }),
    handleCancel: (handler) =>
      Effect.suspend(() => {
        cancelHandlers.push(handler);
        return Effect.void;
      }),
    handleUnknownExtRequest: (handler) =>
      Effect.suspend(() => {
        unknownExtRequestHandler = handler;
        return Effect.void;
      }),
    handleUnknownExtNotification: (handler) =>
      Effect.suspend(() => {
        unknownExtNotificationHandler = handler;
        return Effect.void;
      }),
    handleExtRequest: (method, payload, handler) =>
      Effect.suspend(() => {
        extRequestHandlers.set(method, decodeExtRequestRegistration(method, payload, handler));
        return Effect.void;
      }),
    handleExtNotification: (method, payload, handler) =>
      Effect.suspend(() => {
        extNotificationHandlers.set(
          method,
          decodeExtNotificationRegistration(method, payload, handler),
        );
        return Effect.void;
      }),
  });
});

export const layer = (stdio: Stdio.Stdio, options: AcpAgentOptions = {}): Layer.Layer<AcpAgent> =>
  Layer.effect(AcpAgent, make(stdio, options));

export const layerStdio = (
  options: AcpAgentOptions = {},
): Layer.Layer<AcpAgent, never, Stdio.Stdio> =>
  Layer.effect(
    AcpAgent,
    Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) => make(stdio, options)),
  );
