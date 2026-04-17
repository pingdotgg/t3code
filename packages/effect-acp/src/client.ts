import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpRpcs from "./rpc.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
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
}

type AcpClientRaw = {
  readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
};

export interface AcpClientShape {
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
     * Selects the active model for a session.
     * @see https://agentclientprotocol.com/protocol/schema#session/set_model
     */
    readonly setSessionModel: (
      payload: AcpSchema.SetSessionModelRequest,
    ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
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
    handler: (
      request: AcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `session/elicitation`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  readonly handleElicitation: (
    handler: (
      request: AcpSchema.ElicitationRequest,
    ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `fs/read_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readonly handleReadTextFile: (
    handler: (
      request: AcpSchema.ReadTextFileRequest,
    ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `fs/write_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  readonly handleWriteTextFile: (
    handler: (
      request: AcpSchema.WriteTextFileRequest,
    ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/create`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  readonly handleCreateTerminal: (
    handler: (
      request: AcpSchema.CreateTerminalRequest,
    ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/output`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  readonly handleTerminalOutput: (
    handler: (
      request: AcpSchema.TerminalOutputRequest,
    ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/wait_for_exit`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  readonly handleTerminalWaitForExit: (
    handler: (
      request: AcpSchema.WaitForTerminalExitRequest,
    ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/kill`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  readonly handleTerminalKill: (
    handler: (
      request: AcpSchema.KillTerminalRequest,
    ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/release`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  readonly handleTerminalRelease: (
    handler: (
      request: AcpSchema.ReleaseTerminalRequest,
    ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>,
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
   * Registers a handler for `session/elicitation/complete`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly handleElicitationComplete: (
    handler: (
      notification: AcpSchema.ElicitationCompleteNotification,
    ) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a fallback extension request handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleUnknownExtRequest: (
    handler: (method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>,
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
    handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
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

export class AcpClient extends Context.Service<AcpClient, AcpClientShape>()(
  "effect-acp/AcpClient",
) {}

interface AcpCoreRequestHandlers {
  requestPermission?: (
    request: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
  elicitation?: (
    request: AcpSchema.ElicitationRequest,
  ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
  readTextFile?: (
    request: AcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
  writeTextFile?: (
    request: AcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>;
  createTerminal?: (
    request: AcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>;
  terminalOutput?: (
    request: AcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>;
  terminalWaitForExit?: (
    request: AcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>;
  terminalKill?: (
    request: AcpSchema.KillTerminalRequest,
  ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>;
  terminalRelease?: (
    request: AcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>;
}

interface AcpNotificationHandlers {
  readonly sessionUpdate: BufferedNotificationHandler<AcpSchema.SessionNotification>;
  readonly elicitationComplete: BufferedNotificationHandler<AcpSchema.ElicitationCompleteNotification>;
}

interface BufferedNotificationHandler<A> {
  readonly handlers: Array<(notification: A) => Effect.Effect<void, AcpError.AcpError>>;
  readonly pending: Array<A>;
}

export const make = Effect.fn("effect-acp/AcpClient.make")(function* (
  stdio: Stdio.Stdio,
  options: AcpClientOptions = {},
  terminationError?: Effect.Effect<AcpError.AcpError>,
): Effect.fn.Return<AcpClientShape, never, Scope.Scope> {
  const coreHandlers: AcpCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: { handlers: [], pending: [] },
    elicitationComplete: { handlers: [], pending: [] },
  };
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

  const dispatchExtRequest = (method: string, params: unknown) => {
    const handler = extRequestHandlers.get(method);
    if (handler) {
      return handler(params);
    }
    return unknownExtRequestHandler
      ? unknownExtRequestHandler(method, params)
      : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
  };

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: stdio,
    ...(terminationError ? { terminationError } : {}),
    serverRequestMethods: new Set(AcpRpcs.ClientRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onExtRequest: dispatchExtRequest,
  });

  const clientHandlerLayer = AcpRpcs.ClientRpcs.toLayer(
    AcpRpcs.ClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload) =>
        runHandler(
          coreHandlers.requestPermission,
          payload,
          CLIENT_METHODS.session_request_permission,
        ),
      [CLIENT_METHODS.session_elicitation]: (payload) =>
        runHandler(coreHandlers.elicitation, payload, CLIENT_METHODS.session_elicitation),
      [CLIENT_METHODS.fs_read_text_file]: (payload) =>
        runHandler(coreHandlers.readTextFile, payload, CLIENT_METHODS.fs_read_text_file),
      [CLIENT_METHODS.fs_write_text_file]: (payload) =>
        runHandler(coreHandlers.writeTextFile, payload, CLIENT_METHODS.fs_write_text_file).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_create]: (payload) =>
        runHandler(coreHandlers.createTerminal, payload, CLIENT_METHODS.terminal_create),
      [CLIENT_METHODS.terminal_output]: (payload) =>
        runHandler(coreHandlers.terminalOutput, payload, CLIENT_METHODS.terminal_output),
      [CLIENT_METHODS.terminal_wait_for_exit]: (payload) =>
        runHandler(
          coreHandlers.terminalWaitForExit,
          payload,
          CLIENT_METHODS.terminal_wait_for_exit,
        ),
      [CLIENT_METHODS.terminal_kill]: (payload) =>
        runHandler(coreHandlers.terminalKill, payload, CLIENT_METHODS.terminal_kill).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_release]: (payload) =>
        runHandler(coreHandlers.terminalRelease, payload, CLIENT_METHODS.terminal_release).pipe(
          Effect.map((result) => result ?? {}),
        ),
    }),
  );

  yield* RpcServer.make(AcpRpcs.ClientRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(clientHandlerLayer),
    Effect.forkScoped,
  );

  let nextRpcRequestId = 1n << 32n;
  const rpc = yield* RpcClient.make(AcpRpcs.AgentRpcs, {
    generateRequestId: () => nextRpcRequestId++ as never,
  }).pipe(Effect.provideService(RpcClient.Protocol, transport.clientProtocol));

  return AcpClient.of({
    raw: {
      notifications: transport.incoming,
      request: transport.request,
      notify: transport.notify,
    },
    agent: {
      initialize: (payload) => callRpc(rpc[AGENT_METHODS.initialize](payload)),
      authenticate: (payload) => callRpc(rpc[AGENT_METHODS.authenticate](payload)),
      logout: (payload) => callRpc(rpc[AGENT_METHODS.logout](payload)),
      createSession: (payload) => callRpc(rpc[AGENT_METHODS.session_new](payload)),
      loadSession: (payload) => callRpc(rpc[AGENT_METHODS.session_load](payload)),
      listSessions: (payload) => callRpc(rpc[AGENT_METHODS.session_list](payload)),
      forkSession: (payload) => callRpc(rpc[AGENT_METHODS.session_fork](payload)),
      resumeSession: (payload) => callRpc(rpc[AGENT_METHODS.session_resume](payload)),
      closeSession: (payload) => callRpc(rpc[AGENT_METHODS.session_close](payload)),
      setSessionModel: (payload) => callRpc(rpc[AGENT_METHODS.session_set_model](payload)),
      setSessionConfigOption: (payload) =>
        callRpc(rpc[AGENT_METHODS.session_set_config_option](payload)),
      prompt: (payload) => callRpc(rpc[AGENT_METHODS.session_prompt](payload)),
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

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpClientOptions = {},
): Layer.Layer<AcpClient> => {
  const stdio = makeChildStdio(handle);
  const terminationError = makeTerminationError(handle);
  return Layer.effect(AcpClient, make(stdio, options, terminationError));
};
