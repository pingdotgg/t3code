import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpRpcs from "./rpc.ts";
import * as AcpSchema from "./schema.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";
import {
  callRpc,
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export interface AcpClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onIncomingRequest?: AcpProtocol.AcpPatchedProtocolOptions["onIncomingRequest"];
  readonly onTermination?: AcpProtocol.AcpPatchedProtocolOptions["onTermination"];
  readonly onOutgoingResponseFailure?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpProtocol.AcpPatchedProtocolOptions["onOutgoingResponse"];
}

type AcpClientRaw = {
  readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
};

export type AcpRequestHandler<Request, Response> = AcpProtocol.AcpRequestHandler<Request, Response>;

export class AcpClient extends Context.Service<
  AcpClient,
  {
    readonly raw: AcpClientRaw;
    readonly agent: {
      /**
       * Initializes the ACP session and negotiates capabilities.
       * @see https://agentclientprotocol.com/protocol/schema#initialize
       */
      readonly initialize: (
        payload: AcpSchema.InitializeRequest,
      ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
      /**
       * Performs ACP authentication when the agent requires it.
       * @see https://agentclientprotocol.com/protocol/schema#authenticate
       */
      readonly authenticate: (
        payload: AcpSchema.AuthenticateRequest,
      ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
      /**
       * Logs out the current ACP identity.
       * @see https://agentclientprotocol.com/protocol/schema#logout
       */
      readonly logout: (
        payload: AcpSchema.LogoutRequest,
      ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
      /**
       * Starts a new ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/new
       */
      readonly createSession: (
        payload: AcpSchema.NewSessionRequest,
      ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
      /**
       * Loads a previously saved ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/load
       */
      readonly loadSession: (
        payload: AcpSchema.LoadSessionRequest,
      ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
      /**
       * Lists available ACP sessions.
       * @see https://agentclientprotocol.com/protocol/schema#session/list
       */
      readonly listSessions: (
        payload: AcpSchema.ListSessionsRequest,
      ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
      /**
       * Forks an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/fork
       */
      readonly forkSession: (
        payload: AcpSchema.ForkSessionRequest,
      ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
      /**
       * Resumes an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/resume
       */
      readonly resumeSession: (
        payload: AcpSchema.ResumeSessionRequest,
      ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
      /**
       * Closes an ACP session.
       * @see https://agentclientprotocol.com/protocol/schema#session/close
       */
      readonly closeSession: (
        payload: AcpSchema.CloseSessionRequest,
      ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
      /**
       * Updates a session configuration option.
       * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
       */
      readonly setSessionConfigOption: (
        payload: AcpSchema.SetSessionConfigOptionRequest,
      ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
      /**
       * Sends a prompt turn to the agent.
       * @see https://agentclientprotocol.com/protocol/schema#session/prompt
       */
      readonly prompt: (
        payload: AcpSchema.PromptRequest,
      ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
      /**
       * Sends a real ACP `session/cancel` notification.
       * @see https://agentclientprotocol.com/protocol/schema#session/cancel
       */
      readonly cancel: (
        payload: AcpSchema.CancelNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
    };
    /**
     * Registers a handler for `session/request_permission`.
     * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
     */
    readonly handleRequestPermission: (
      handler: AcpRequestHandler<
        AcpSchema.RequestPermissionRequest,
        AcpSchema.RequestPermissionResponse
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `elicitation/create` requests.
     * @see https://agentclientprotocol.com/protocol/schema#elicitation/create
     */
    readonly handleElicitation: (
      handler: AcpRequestHandler<
        AcpSchema.CreateElicitationRequest,
        AcpSchema.CreateElicitationResponse
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `fs/read_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
     */
    readonly handleReadTextFile: (
      handler: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `fs/write_text_file`.
     * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
     */
    readonly handleWriteTextFile: (
      handler: AcpRequestHandler<
        AcpSchema.WriteTextFileRequest,
        AcpSchema.WriteTextFileResponse | void
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `terminal/create`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/create
     */
    readonly handleCreateTerminal: (
      handler: AcpRequestHandler<AcpSchema.CreateTerminalRequest, AcpSchema.CreateTerminalResponse>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `terminal/output`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/output
     */
    readonly handleTerminalOutput: (
      handler: AcpRequestHandler<AcpSchema.TerminalOutputRequest, AcpSchema.TerminalOutputResponse>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `terminal/wait_for_exit`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
     */
    readonly handleTerminalWaitForExit: (
      handler: AcpRequestHandler<
        AcpSchema.WaitForTerminalExitRequest,
        AcpSchema.WaitForTerminalExitResponse
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `terminal/kill`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
     */
    readonly handleTerminalKill: (
      handler: AcpRequestHandler<
        AcpSchema.KillTerminalRequest,
        AcpSchema.KillTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `terminal/release`.
     * @see https://agentclientprotocol.com/protocol/schema#terminal/release
     */
    readonly handleTerminalRelease: (
      handler: AcpRequestHandler<
        AcpSchema.ReleaseTerminalRequest,
        AcpSchema.ReleaseTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `session/update`.
     * @see https://agentclientprotocol.com/protocol/schema#session/update
     */
    readonly handleSessionUpdate: (
      handler: (
        notification: AcpSchema.SessionNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a handler for `elicitation/complete`.
     * @see https://agentclientprotocol.com/protocol/schema#elicitation/complete
     */
    readonly handleElicitationComplete: (
      handler: (
        notification: AcpSchema.CompleteElicitationNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a fallback extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtRequest: (
      handler: (
        method: string,
        params: unknown,
        context: AcpProtocol.AcpRequestContext,
      ) => Effect.Effect<unknown, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a fallback extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleUnknownExtNotification: (
      handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    /**
     * Registers a typed extension request handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtRequest: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: AcpRequestHandler<A, unknown>,
    ) => Effect.Effect<void>;
    /**
     * Registers a typed extension notification handler.
     * @see https://agentclientprotocol.com/protocol/extensibility
     */
    readonly handleExtNotification: <A, I>(
      method: string,
      payload: Schema.Codec<A, I>,
      handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
  }
>()("effect-acp/client/AcpClient") {}

interface AcpCoreRequestHandlers {
  requestPermission?: AcpRequestHandler<
    AcpSchema.RequestPermissionRequest,
    AcpSchema.RequestPermissionResponse
  >;
  elicitation?: AcpRequestHandler<
    AcpSchema.CreateElicitationRequest,
    AcpSchema.CreateElicitationResponse
  >;
  readTextFile?: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>;
  writeTextFile?: AcpRequestHandler<
    AcpSchema.WriteTextFileRequest,
    AcpSchema.WriteTextFileResponse | void
  >;
  createTerminal?: AcpRequestHandler<
    AcpSchema.CreateTerminalRequest,
    AcpSchema.CreateTerminalResponse
  >;
  terminalOutput?: AcpRequestHandler<
    AcpSchema.TerminalOutputRequest,
    AcpSchema.TerminalOutputResponse
  >;
  terminalWaitForExit?: AcpRequestHandler<
    AcpSchema.WaitForTerminalExitRequest,
    AcpSchema.WaitForTerminalExitResponse
  >;
  terminalKill?: AcpRequestHandler<
    AcpSchema.KillTerminalRequest,
    AcpSchema.KillTerminalResponse | void
  >;
  terminalRelease?: AcpRequestHandler<
    AcpSchema.ReleaseTerminalRequest,
    AcpSchema.ReleaseTerminalResponse | void
  >;
}

interface AcpNotificationHandlers {
  readonly sessionUpdate: BufferedNotificationHandler<AcpSchema.SessionNotification>;
  readonly elicitationComplete: BufferedNotificationHandler<AcpSchema.CompleteElicitationNotification>;
}

interface BufferedNotificationHandler<A> {
  readonly handlers: Array<(notification: A) => Effect.Effect<void, AcpError.AcpError>>;
  readonly pending: Array<A>;
}

export const make = Effect.fn("effect-acp/AcpClient.make")(function* (
  stdio: Stdio.Stdio,
  options: AcpClientOptions = {},
  terminationError?: Effect.Effect<AcpError.AcpError>,
): Effect.fn.Return<AcpClient["Service"], never, Scope.Scope> {
  const coreHandlers: AcpCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: { handlers: [], pending: [] },
    elicitationComplete: { handlers: [], pending: [] },
  };
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

  const runNotificationHandlers = <A>(
    registration: BufferedNotificationHandler<A>,
    notification: A,
  ) =>
    Effect.forEach(
      registration.handlers,
      (handler) => handler(notification).pipe(Effect.catch(() => Effect.void)),
      { discard: true },
    );

  const flushBufferedNotifications = <A>(registration: BufferedNotificationHandler<A>) =>
    Effect.suspend(() => {
      if (registration.handlers.length === 0 || registration.pending.length === 0) {
        return Effect.void;
      }
      const pending = registration.pending.splice(0, registration.pending.length);
      return Effect.forEach(
        pending,
        (notification) => runNotificationHandlers(registration, notification),
        {
          discard: true,
        },
      );
    });

  const dispatchNotification = (notification: AcpProtocol.AcpIncomingNotification) => {
    switch (notification._tag) {
      case "SessionUpdate": {
        if (notificationHandlers.sessionUpdate.handlers.length === 0) {
          notificationHandlers.sessionUpdate.pending.push(notification.params);
          return Effect.void;
        }
        return runNotificationHandlers(notificationHandlers.sessionUpdate, notification.params);
      }
      case "ElicitationComplete": {
        if (notificationHandlers.elicitationComplete.handlers.length === 0) {
          notificationHandlers.elicitationComplete.pending.push(notification.params);
          return Effect.void;
        }
        return runNotificationHandlers(
          notificationHandlers.elicitationComplete,
          notification.params,
        );
      }
      case "ExtNotification": {
        const handler = extNotificationHandlers.get(notification.method);
        if (handler) {
          return handler(notification.params);
        }
        return unknownExtNotificationHandler
          ? unknownExtNotificationHandler(notification.method, notification.params)
          : Effect.void;
      }
    }
  };

  const dispatchExtRequest = (
    method: string,
    params: unknown,
    context: AcpProtocol.AcpRequestContext,
  ) => {
    const handler = extRequestHandlers.get(method);
    if (handler) {
      return handler(params, context);
    }
    return unknownExtRequestHandler
      ? unknownExtRequestHandler(method, params, context)
      : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
  };

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: stdio,
    ...(terminationError ? { terminationError } : {}),
    serverRequestMethods: new Set(AcpRpcs.ClientRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
    ...(options.onTermination ? { onTermination: options.onTermination } : {}),
    ...(options.onOutgoingResponseFailure
      ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
      : {}),
    ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
    onNotification: dispatchNotification,
    onExtRequest: dispatchExtRequest,
  });

  const requestContext = (
    requestId: RpcMessage.RequestId,
    method: string,
  ): AcpProtocol.AcpRequestContext => ({
    requestId: AcpProtocol.acpRequestIdentity(requestId),
    method,
  });

  const clientHandlerLayer = AcpRpcs.ClientRpcs.toLayer(
    AcpRpcs.ClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.requestPermission,
          payload,
          CLIENT_METHODS.session_request_permission,
          requestContext(requestId, CLIENT_METHODS.session_request_permission),
        ),
      [CLIENT_METHODS.elicitation_create]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.elicitation,
          payload,
          CLIENT_METHODS.elicitation_create,
          requestContext(requestId, CLIENT_METHODS.elicitation_create),
        ),
      [CLIENT_METHODS.fs_read_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.readTextFile,
          payload,
          CLIENT_METHODS.fs_read_text_file,
          requestContext(requestId, CLIENT_METHODS.fs_read_text_file),
        ),
      [CLIENT_METHODS.fs_write_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.writeTextFile,
          payload,
          CLIENT_METHODS.fs_write_text_file,
          requestContext(requestId, CLIENT_METHODS.fs_write_text_file),
        ).pipe(Effect.map((result) => result ?? {})),
      [CLIENT_METHODS.terminal_create]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.createTerminal,
          payload,
          CLIENT_METHODS.terminal_create,
          requestContext(requestId, CLIENT_METHODS.terminal_create),
        ),
      [CLIENT_METHODS.terminal_output]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalOutput,
          payload,
          CLIENT_METHODS.terminal_output,
          requestContext(requestId, CLIENT_METHODS.terminal_output),
        ),
      [CLIENT_METHODS.terminal_wait_for_exit]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalWaitForExit,
          payload,
          CLIENT_METHODS.terminal_wait_for_exit,
          requestContext(requestId, CLIENT_METHODS.terminal_wait_for_exit),
        ),
      [CLIENT_METHODS.terminal_kill]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalKill,
          payload,
          CLIENT_METHODS.terminal_kill,
          requestContext(requestId, CLIENT_METHODS.terminal_kill),
        ).pipe(Effect.map((result) => result ?? {})),
      [CLIENT_METHODS.terminal_release]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalRelease,
          payload,
          CLIENT_METHODS.terminal_release,
          requestContext(requestId, CLIENT_METHODS.terminal_release),
        ).pipe(Effect.map((result) => result ?? {})),
    }),
  );

  yield* RpcServer.make(AcpRpcs.ClientRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(clientHandlerLayer),
    Effect.forkScoped,
  );

  let nextRpcRequestId = 2 ** 32;
  const rpc = yield* RpcClient.make(AcpRpcs.AgentRpcs, {
    generateRequestId: () => RpcMessage.RequestId(nextRpcRequestId++),
  }).pipe(Effect.provideService(RpcClient.Protocol, transport.clientProtocol));

  return AcpClient.of({
    raw: {
      notifications: transport.incoming,
      request: transport.request,
      notify: transport.notify,
    },
    agent: {
      initialize: (payload) =>
        callRpc(AGENT_METHODS.initialize, rpc[AGENT_METHODS.initialize](payload)),
      authenticate: (payload) =>
        callRpc(AGENT_METHODS.authenticate, rpc[AGENT_METHODS.authenticate](payload)),
      logout: (payload) => callRpc(AGENT_METHODS.logout, rpc[AGENT_METHODS.logout](payload)),
      createSession: (payload) =>
        callRpc(AGENT_METHODS.session_new, rpc[AGENT_METHODS.session_new](payload)),
      loadSession: (payload) =>
        callRpc(AGENT_METHODS.session_load, rpc[AGENT_METHODS.session_load](payload)),
      listSessions: (payload) =>
        callRpc(AGENT_METHODS.session_list, rpc[AGENT_METHODS.session_list](payload)),
      forkSession: (payload) =>
        callRpc(AGENT_METHODS.session_fork, rpc[AGENT_METHODS.session_fork](payload)),
      resumeSession: (payload) =>
        callRpc(AGENT_METHODS.session_resume, rpc[AGENT_METHODS.session_resume](payload)),
      closeSession: (payload) =>
        callRpc(AGENT_METHODS.session_close, rpc[AGENT_METHODS.session_close](payload)),
      setSessionConfigOption: (payload) =>
        callRpc(
          AGENT_METHODS.session_set_config_option,
          rpc[AGENT_METHODS.session_set_config_option](payload),
        ),
      prompt: (payload) =>
        callRpc(AGENT_METHODS.session_prompt, rpc[AGENT_METHODS.session_prompt](payload)),
      cancel: (payload) => transport.notify(AGENT_METHODS.session_cancel, payload),
    },
    handleRequestPermission: (handler) =>
      Effect.suspend(() => {
        coreHandlers.requestPermission = handler;
        return Effect.void;
      }),
    handleElicitation: (handler) =>
      Effect.suspend(() => {
        coreHandlers.elicitation = handler;
        return Effect.void;
      }),
    handleReadTextFile: (handler) =>
      Effect.suspend(() => {
        coreHandlers.readTextFile = handler;
        return Effect.void;
      }),
    handleWriteTextFile: (handler) =>
      Effect.suspend(() => {
        coreHandlers.writeTextFile = handler;
        return Effect.void;
      }),
    handleCreateTerminal: (handler) =>
      Effect.suspend(() => {
        coreHandlers.createTerminal = handler;
        return Effect.void;
      }),
    handleTerminalOutput: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalOutput = handler;
        return Effect.void;
      }),
    handleTerminalWaitForExit: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalWaitForExit = handler;
        return Effect.void;
      }),
    handleTerminalKill: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalKill = handler;
        return Effect.void;
      }),
    handleTerminalRelease: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalRelease = handler;
        return Effect.void;
      }),
    handleSessionUpdate: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.sessionUpdate.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.sessionUpdate);
      }),
    handleElicitationComplete: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.elicitationComplete.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.elicitationComplete);
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

export const layer = (stdio: Stdio.Stdio, options: AcpClientOptions = {}): Layer.Layer<AcpClient> =>
  Layer.effect(AcpClient, make(stdio, options));

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpClientOptions = {},
): Layer.Layer<AcpClient> => {
  const stdio = makeChildStdio(handle);
  const terminationError = makeTerminationError(handle);
  return Layer.effect(AcpClient, make(stdio, options, terminationError));
};
