import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import * as AcpSchema from "./schema.ts";
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

export interface AcpAgentOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
}

export type AcpRequestHandler<Request, Response> = AcpProtocol.AcpRequestHandler<Request, Response>;

export class AcpAgent extends Context.Service<
  AcpAgent,
  {
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
       * @see https://agentclientprotocol.com/protocol/schema#elicitation/create
       */
      readonly elicit: (
        payload: AcpSchema.CreateElicitationRequest,
      ) => Effect.Effect<AcpSchema.CreateElicitationResponse, AcpError.AcpError>;
      /**
       * Sends a `session/update` notification to the client.
       * @see https://agentclientprotocol.com/protocol/schema#session/update
       */
      readonly sessionUpdate: (
        payload: AcpSchema.SessionNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
      /**
       * Sends an `elicitation/complete` notification to the client.
       * @see https://agentclientprotocol.com/protocol/schema#elicitation/complete
       */
      readonly elicitationComplete: (
        payload: AcpSchema.CompleteElicitationNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
      readonly connectMcp: (
        payload: AcpSchema.ConnectMcpRequest,
      ) => Effect.Effect<AcpSchema.ConnectMcpResponse, AcpError.AcpError>;
      readonly messageMcp: (
        payload: AcpSchema.MessageMcpRequest,
      ) => Effect.Effect<AcpSchema.MessageMcpResponse, AcpError.AcpError>;
      readonly disconnectMcp: (
        payload: AcpSchema.DisconnectMcpRequest,
      ) => Effect.Effect<AcpSchema.DisconnectMcpResponse, AcpError.AcpError>;
      readonly notifyMcp: (
        payload: AcpSchema.MessageMcpNotification,
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
      handler: AcpRequestHandler<AcpSchema.InitializeRequest, AcpSchema.InitializeResponse>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `authenticate`.
     * @see https://agentclientprotocol.com/protocol/schema#authenticate
     */
    readonly handleAuthenticate: (
      handler: AcpRequestHandler<AcpSchema.AuthenticateRequest, AcpSchema.AuthenticateResponse>,
    ) => Effect.Effect<void>;
    readonly handleLogout: (
      handler: AcpRequestHandler<AcpSchema.LogoutRequest, AcpSchema.LogoutResponse>,
    ) => Effect.Effect<void>;
    readonly handleCreateSession: (
      handler: AcpRequestHandler<AcpSchema.NewSessionRequest, AcpSchema.NewSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleLoadSession: (
      handler: AcpRequestHandler<AcpSchema.LoadSessionRequest, AcpSchema.LoadSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleListSessions: (
      handler: AcpRequestHandler<AcpSchema.ListSessionsRequest, AcpSchema.ListSessionsResponse>,
    ) => Effect.Effect<void>;
    readonly handleForkSession: (
      handler: AcpRequestHandler<AcpSchema.ForkSessionRequest, AcpSchema.ForkSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleResumeSession: (
      handler: AcpRequestHandler<AcpSchema.ResumeSessionRequest, AcpSchema.ResumeSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleCloseSession: (
      handler: AcpRequestHandler<AcpSchema.CloseSessionRequest, AcpSchema.CloseSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleDeleteSession: (
      handler: AcpRequestHandler<AcpSchema.DeleteSessionRequest, AcpSchema.DeleteSessionResponse>,
    ) => Effect.Effect<void>;
    readonly handleListProviders: (
      handler: AcpRequestHandler<AcpSchema.ListProvidersRequest, AcpSchema.ListProvidersResponse>,
    ) => Effect.Effect<void>;
    readonly handleSetProvider: (
      handler: AcpRequestHandler<AcpSchema.SetProviderRequest, AcpSchema.SetProviderResponse>,
    ) => Effect.Effect<void>;
    readonly handleDisableProvider: (
      handler: AcpRequestHandler<
        AcpSchema.DisableProviderRequest,
        AcpSchema.DisableProviderResponse
      >,
    ) => Effect.Effect<void>;
    readonly handleSetSessionConfigOption: (
      handler: AcpRequestHandler<
        AcpSchema.SetSessionConfigOptionRequest,
        AcpSchema.SetSessionConfigOptionResponse
      >,
    ) => Effect.Effect<void>;
    readonly handlePrompt: (
      handler: AcpRequestHandler<AcpSchema.PromptRequest, AcpSchema.PromptResponse>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `session/cancel`.
     * @see https://agentclientprotocol.com/protocol/schema#session/cancel
     */
    readonly handleCancel: (
      handler: (
        notification: AcpSchema.CancelNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownExtRequest: (
      handler: (
        method: string,
        params: unknown,
        context: AcpProtocol.AcpRequestContext,
      ) => Effect.Effect<unknown, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownExtNotification: (
      handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    readonly handleExtRequest: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: AcpRequestHandler<A, unknown>,
    ) => Effect.Effect<void>;
    readonly handleExtNotification: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
  }
>()("effect-acp/agent/AcpAgent") {}

interface AcpCoreAgentRequestHandlers {
  initialize?: AcpRequestHandler<AcpSchema.InitializeRequest, AcpSchema.InitializeResponse>;
  authenticate?: AcpRequestHandler<AcpSchema.AuthenticateRequest, AcpSchema.AuthenticateResponse>;
  logout?: AcpRequestHandler<AcpSchema.LogoutRequest, AcpSchema.LogoutResponse>;
  createSession?: AcpRequestHandler<AcpSchema.NewSessionRequest, AcpSchema.NewSessionResponse>;
  loadSession?: AcpRequestHandler<AcpSchema.LoadSessionRequest, AcpSchema.LoadSessionResponse>;
  listSessions?: AcpRequestHandler<AcpSchema.ListSessionsRequest, AcpSchema.ListSessionsResponse>;
  forkSession?: AcpRequestHandler<AcpSchema.ForkSessionRequest, AcpSchema.ForkSessionResponse>;
  resumeSession?: AcpRequestHandler<
    AcpSchema.ResumeSessionRequest,
    AcpSchema.ResumeSessionResponse
  >;
  closeSession?: AcpRequestHandler<AcpSchema.CloseSessionRequest, AcpSchema.CloseSessionResponse>;
  deleteSession?: AcpRequestHandler<
    AcpSchema.DeleteSessionRequest,
    AcpSchema.DeleteSessionResponse
  >;
  listProviders?: AcpRequestHandler<
    AcpSchema.ListProvidersRequest,
    AcpSchema.ListProvidersResponse
  >;
  setProvider?: AcpRequestHandler<AcpSchema.SetProviderRequest, AcpSchema.SetProviderResponse>;
  disableProvider?: AcpRequestHandler<
    AcpSchema.DisableProviderRequest,
    AcpSchema.DisableProviderResponse
  >;
  setSessionConfigOption?: AcpRequestHandler<
    AcpSchema.SetSessionConfigOptionRequest,
    AcpSchema.SetSessionConfigOptionResponse
  >;
  prompt?: AcpRequestHandler<AcpSchema.PromptRequest, AcpSchema.PromptResponse>;
}

const decodeCancelNotification = Schema.decodeUnknownEffect(AcpSchema.CancelNotification);

export const make = Effect.fn("effect-acp/AcpAgent.make")(function* (
  stdio: Stdio.Stdio,
  options: AcpAgentOptions = {},
): Effect.fn.Return<AcpAgent["Service"], never, Scope.Scope> {
  const coreHandlers: AcpCoreAgentRequestHandlers = {};
  const cancelHandlers: Array<
    (notification: AcpSchema.CancelNotification) => Effect.Effect<void, AcpError.AcpError>
  > = [];
  const extRequestHandlers = new Map<string, AcpRequestHandler<unknown, unknown>>();
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpError.AcpError>
  >();
  let unknownExtRequestHandler:
    | ((
        method: string,
        params: unknown,
        context: AcpProtocol.AcpRequestContext,
      ) => Effect.Effect<unknown, AcpError.AcpError>)
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
          Effect.mapError((error) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              AGENT_METHODS.session_cancel,
              error,
            ),
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
    onExtRequest: (method, params, context) => {
      const handler = extRequestHandlers.get(method);
      if (handler) {
        return handler(params, context);
      }
      return unknownExtRequestHandler
        ? unknownExtRequestHandler(method, params, context)
        : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    },
  });

  const requestContext = (
    requestId: RpcMessage.RequestId,
    method: string,
  ): AcpProtocol.AcpRequestContext => ({
    requestId: AcpProtocol.acpRequestIdentity(requestId),
    method,
  });

  const agentHandlerLayer = AcpRpcs.AgentRpcs.toLayer(
    AcpRpcs.AgentRpcs.of({
      [AGENT_METHODS.initialize]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.initialize,
          payload,
          AGENT_METHODS.initialize,
          requestContext(requestId, AGENT_METHODS.initialize),
        ),
      [AGENT_METHODS.auth_login]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.authenticate,
          payload,
          AGENT_METHODS.auth_login,
          requestContext(requestId, AGENT_METHODS.auth_login),
        ),
      [AGENT_METHODS.auth_logout]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.logout,
          payload,
          AGENT_METHODS.auth_logout,
          requestContext(requestId, AGENT_METHODS.auth_logout),
        ),
      [AGENT_METHODS.session_new]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.createSession,
          payload,
          AGENT_METHODS.session_new,
          requestContext(requestId, AGENT_METHODS.session_new),
        ),
      [AGENT_METHODS.session_list]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.listSessions,
          payload,
          AGENT_METHODS.session_list,
          requestContext(requestId, AGENT_METHODS.session_list),
        ),
      [AGENT_METHODS.session_fork]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.forkSession,
          payload,
          AGENT_METHODS.session_fork,
          requestContext(requestId, AGENT_METHODS.session_fork),
        ),
      [AGENT_METHODS.session_resume]: (payload, { requestId }) =>
        runHandler(
          payload.replayFrom?.type === "start"
            ? (coreHandlers.loadSession ?? coreHandlers.resumeSession)
            : (coreHandlers.resumeSession ?? coreHandlers.loadSession),
          payload,
          AGENT_METHODS.session_resume,
          requestContext(requestId, AGENT_METHODS.session_resume),
        ),
      [AGENT_METHODS.session_close]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.closeSession,
          payload,
          AGENT_METHODS.session_close,
          requestContext(requestId, AGENT_METHODS.session_close),
        ),
      [AGENT_METHODS.session_delete]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.deleteSession,
          payload,
          AGENT_METHODS.session_delete,
          requestContext(requestId, AGENT_METHODS.session_delete),
        ),
      [AGENT_METHODS.providers_list]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.listProviders,
          payload,
          AGENT_METHODS.providers_list,
          requestContext(requestId, AGENT_METHODS.providers_list),
        ),
      [AGENT_METHODS.providers_set]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.setProvider,
          payload,
          AGENT_METHODS.providers_set,
          requestContext(requestId, AGENT_METHODS.providers_set),
        ),
      [AGENT_METHODS.providers_disable]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.disableProvider,
          payload,
          AGENT_METHODS.providers_disable,
          requestContext(requestId, AGENT_METHODS.providers_disable),
        ),
      [AGENT_METHODS.session_set_config_option]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.setSessionConfigOption,
          payload,
          AGENT_METHODS.session_set_config_option,
          requestContext(requestId, AGENT_METHODS.session_set_config_option),
        ),
      [AGENT_METHODS.session_prompt]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.prompt,
          payload,
          AGENT_METHODS.session_prompt,
          requestContext(requestId, AGENT_METHODS.session_prompt),
        ),
    }),
  );

  yield* RpcServer.make(AcpRpcs.AgentRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(agentHandlerLayer),
    Effect.forkScoped,
  );

  let nextRpcRequestId = 2 ** 32;
  const rpc = yield* RpcClient.make(AcpRpcs.ClientRpcs, {
    generateRequestId: () => RpcMessage.RequestId(nextRpcRequestId++),
  }).pipe(Effect.provideService(RpcClient.Protocol, transport.clientProtocol));

  return AcpAgent.of({
    raw: {
      notifications: transport.incoming,
      request: transport.request,
      notify: transport.notify,
    },
    client: {
      requestPermission: (payload) =>
        callRpc(
          CLIENT_METHODS.session_request_permission,
          rpc[CLIENT_METHODS.session_request_permission](payload),
        ),
      elicit: (payload) =>
        callRpc(CLIENT_METHODS.elicitation_create, rpc[CLIENT_METHODS.elicitation_create](payload)),
      sessionUpdate: (payload) => transport.notify(CLIENT_METHODS.session_update, payload),
      elicitationComplete: (payload) =>
        transport.notify(CLIENT_METHODS.elicitation_complete, payload),
      connectMcp: (payload) =>
        callRpc(CLIENT_METHODS.mcp_connect, rpc[CLIENT_METHODS.mcp_connect](payload)),
      messageMcp: (payload) =>
        callRpc(CLIENT_METHODS.mcp_message, rpc[CLIENT_METHODS.mcp_message](payload)),
      disconnectMcp: (payload) =>
        callRpc(CLIENT_METHODS.mcp_disconnect, rpc[CLIENT_METHODS.mcp_disconnect](payload)),
      notifyMcp: (payload) => transport.notify(CLIENT_METHODS.mcp_message, payload),
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
    handleDeleteSession: (handler) =>
      Effect.suspend(() => {
        coreHandlers.deleteSession = handler;
        return Effect.void;
      }),
    handleListProviders: (handler) =>
      Effect.suspend(() => {
        coreHandlers.listProviders = handler;
        return Effect.void;
      }),
    handleSetProvider: (handler) =>
      Effect.suspend(() => {
        coreHandlers.setProvider = handler;
        return Effect.void;
      }),
    handleDisableProvider: (handler) =>
      Effect.suspend(() => {
        coreHandlers.disableProvider = handler;
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
