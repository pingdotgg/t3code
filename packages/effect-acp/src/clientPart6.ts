import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpRpcs from "./rpc.ts";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpSchemaV2 from "./_generated/schema.gen.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen.ts";
import {
  callRpc,
  decodeExtNotificationRegistration,
  decodeExtRequestRegistration,
  isolateNotificationHandler,
  runHandler,
} from "./_internal/shared.ts";
import type { AcpClientOptions, AcpCoreRequestHandlers, AcpNotificationHandlers, AcpRequestHandler, BufferedNotificationHandler } from "./clientPart2.ts";
import { decodeElicitationRequest } from "./clientPart2.ts";
import { normalizeConfigOptions, normalizeSessionUpdate, normalizeV1SessionUpdate, toV2McpServer, toV2ResumeRequest } from "./clientPart3.ts";
import { isV2InitializeResponse, normalizeInitializeResponse, normalizePermissionRequest, normalizeV2SessionSetupResponse, toNegotiatingInitializeRequest, toV2ForkRequest } from "./clientPart4.ts";
import { decodeMessageMcpNotification } from "./clientPart5.ts";
import { AcpClient } from "./client.ts";

export const make = Effect.fn("effect-acp/AcpClient.make")(function* (
  stdio: AcpProtocol.AcpStdio,
  options: AcpClientOptions = {},
  terminationError?: Effect.Effect<AcpError.AcpError>,
): Effect.fn.Return<AcpClient["Service"], never, Scope.Scope> {
  const coreHandlers: AcpCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: { handlers: [], pending: [] },
    elicitationComplete: { handlers: [], pending: [] },
  };
  const promptCompletions = new Map<
    string,
    Deferred.Deferred<AcpSchema.PromptResponse, AcpError.AcpError>
  >();
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
  let negotiatedProtocolGeneration: 1 | 2 | undefined;
  let sessionDeleteSupported = false;

  const runNotificationHandlers = <A>(
    registration: BufferedNotificationHandler<A>,
    notification: A,
  ) =>
    Effect.forEach(
      registration.handlers,
      (handler) => isolateNotificationHandler(handler(notification)),
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
        const normalized = notification.params as AcpSchema.SessionNotification;
        const state = normalized.update;
        const completePrompt =
          state.sessionUpdate === "state_update" && state.state === "idle"
            ? Effect.suspend(() => {
                const idle = state as Extract<
                  AcpSchema.SessionUpdate,
                  { readonly sessionUpdate: "state_update"; readonly state: "idle" }
                >;
                const completion = promptCompletions.get(normalized.sessionId);
                if (completion === undefined) return Effect.void;
                promptCompletions.delete(normalized.sessionId);
                return Deferred.succeed(completion, {
                  stopReason: idle.stopReason ?? "end_turn",
                  ...(idle.usage === undefined ? {} : { usage: idle.usage }),
                  ...(idle.error === undefined ? {} : { error: idle.error }),
                  ...(idle._meta === undefined ? {} : { _meta: idle._meta }),
                }).pipe(Effect.asVoid);
              })
            : Effect.void;
        if (notificationHandlers.sessionUpdate.handlers.length === 0) {
          notificationHandlers.sessionUpdate.pending.push(normalized);
          return completePrompt;
        }
        return Effect.all(
          [completePrompt, runNotificationHandlers(notificationHandlers.sessionUpdate, normalized)],
          { discard: true },
        );
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
    serverRequestMethods: new Set(AcpRpcs.CompatClientRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onIncomingRequest ? { onIncomingRequest: options.onIncomingRequest } : {}),
    onTermination: (error) =>
      Effect.all(
        [
          ...Array.from(promptCompletions.values(), (completion) =>
            Deferred.fail(completion, error).pipe(Effect.asVoid),
          ),
          options.onTermination?.(error) ?? Effect.void,
        ],
        { discard: true },
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            promptCompletions.clear();
          }),
        ),
      ),
    ...(options.onOutgoingResponseFailure
      ? { onOutgoingResponseFailure: options.onOutgoingResponseFailure }
      : {}),
    ...(options.onOutgoingResponse ? { onOutgoingResponse: options.onOutgoingResponse } : {}),
    transformSessionUpdate: (notification) => {
      const normalized =
        negotiatedProtocolGeneration === 1
          ? normalizeV1SessionUpdate(notification as AcpSchemaV1.SessionNotification)
          : normalizeSessionUpdate(notification as AcpSchemaV2.UpdateSessionNotification);
      return options.transformSessionUpdate?.(normalized) ?? normalized;
    },
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

  const layerClientHandler = AcpRpcs.CompatClientRpcs.toLayer(
    AcpRpcs.CompatClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.requestPermission,
          "toolCall" in payload
            ? (payload as AcpSchema.RequestPermissionRequest)
            : normalizePermissionRequest(
                payload,
                requestContext(requestId, CLIENT_METHODS.session_request_permission),
              ),
          CLIENT_METHODS.session_request_permission,
          requestContext(requestId, CLIENT_METHODS.session_request_permission),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.session_elicitation]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.elicitation,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.session_elicitation,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.session_elicitation),
        ).pipe(
          Effect.map(({ _meta, ...action }) => ({
            action,
            ...(_meta === undefined ? {} : { _meta }),
          })),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.elicitation,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.unstable_session_elicitation),
        ).pipe(
          Effect.map(({ _meta, ...action }) => ({
            action,
            ...(_meta === undefined ? {} : { _meta }),
          })),
        ),
      [CLIENT_METHODS.elicitation_create]: (payload, { requestId }) =>
        decodeElicitationRequest(payload).pipe(
          Effect.mapError((cause) =>
            AcpError.AcpRequestError.invalidExtensionPayload(
              CLIENT_METHODS.elicitation_create,
              cause,
            ).toProtocolError(),
          ),
          Effect.flatMap((request) =>
            runHandler(
              coreHandlers.elicitation,
              request,
              CLIENT_METHODS.elicitation_create,
              requestContext(requestId, CLIENT_METHODS.elicitation_create),
            ),
          ),
        ),
      [CLIENT_METHODS.mcp_connect]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.mcpConnect,
          payload,
          CLIENT_METHODS.mcp_connect,
          requestContext(requestId, CLIENT_METHODS.mcp_connect),
        ),
      [CLIENT_METHODS.mcp_message]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.mcpMessage,
          payload,
          CLIENT_METHODS.mcp_message,
          requestContext(requestId, CLIENT_METHODS.mcp_message),
        ),
      [CLIENT_METHODS.mcp_disconnect]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.mcpDisconnect,
          payload,
          CLIENT_METHODS.mcp_disconnect,
          requestContext(requestId, CLIENT_METHODS.mcp_disconnect),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.readTextFile,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.fs_read_text_file),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.writeTextFile,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.fs_write_text_file),
        ).pipe(Effect.map((result) => result ?? {})),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_create]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.createTerminal,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_create,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_create),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_output]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalOutput,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_output,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_output),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalWaitForExit,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_wait_for_exit),
        ),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_kill]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalKill,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_kill,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_kill),
        ).pipe(Effect.map((result) => result ?? {})),
      [AcpRpcs.V1_CLIENT_METHODS.terminal_release]: (payload, { requestId }) =>
        runHandler(
          coreHandlers.terminalRelease,
          payload,
          AcpRpcs.V1_CLIENT_METHODS.terminal_release,
          requestContext(requestId, AcpRpcs.V1_CLIENT_METHODS.terminal_release),
        ).pipe(Effect.map((result) => result ?? {})),
    }),
  );

  yield* RpcServer.make(AcpRpcs.CompatClientRpcs, { disableFatalDefects: true }).pipe(
    // runHandler logs handler defects with their method. A reporter inherited
    // from the caller (a WebSocket request, say) would log them again.
    Effect.provideService(ErrorReporter.CurrentErrorReporters, new Set()),
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(layerClientHandler),
    Effect.forkScoped,
  );

  let nextRpcRequestId = AcpProtocol.RPC_REQUEST_ID_START;
  const rpc = yield* RpcClient.make(AcpRpcs.CompatAgentRpcs, {
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
        callRpc(
          AGENT_METHODS.initialize,
          rpc[AGENT_METHODS.initialize](toNegotiatingInitializeRequest(payload)),
        ).pipe(
          Effect.map((response) => {
            // ACP v1 protocolVersion values were not generation identifiers in
            // every shipped agent. Antigravity, for example, reports version 2
            // with the v1 agentInfo/agentCapabilities response shape.
            const isV2 = isV2InitializeResponse(response);
            negotiatedProtocolGeneration = isV2 ? 2 : 1;
            const normalized = isV2
              ? normalizeInitializeResponse(response)
              : (response as AcpSchema.InitializeResponse);
            sessionDeleteSupported =
              normalized.agentCapabilities?.sessionCapabilities?.delete != null;
            return normalized;
          }),
        ),
      authenticate: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.authenticate,
              rpc[AcpRpcs.V1_AGENT_METHODS.authenticate](payload),
            )
          : callRpc(AGENT_METHODS.auth_login, rpc[AGENT_METHODS.auth_login](payload)),
      logout: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(AcpRpcs.V1_AGENT_METHODS.logout, rpc[AcpRpcs.V1_AGENT_METHODS.logout](payload))
          : callRpc(AGENT_METHODS.auth_logout, rpc[AGENT_METHODS.auth_logout](payload)),
      createSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_new,
              rpc[AGENT_METHODS.session_new](payload as AcpSchemaV1.NewSessionRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.NewSessionResponse))
          : callRpc(
              AGENT_METHODS.session_new,
              rpc[AGENT_METHODS.session_new]({
                ...payload,
                mcpServers: payload.mcpServers.map(toV2McpServer),
              }),
            ).pipe(
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(
                    response as AcpSchemaV2.NewSessionResponse,
                  ) as AcpSchema.NewSessionResponse,
              ),
            ),
      loadSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_load,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_load](payload as AcpSchemaV1.LoadSessionRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.LoadSessionResponse))
          : callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](toV2ResumeRequest(payload, { type: "start" })),
            ).pipe(
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(
                    response as AcpSchemaV2.ResumeSessionResponse,
                  ) as AcpSchema.LoadSessionResponse,
              ),
            ),
      listSessions: (payload) =>
        callRpc(AGENT_METHODS.session_list, rpc[AGENT_METHODS.session_list](payload)).pipe(
          Effect.map((response) => response as AcpSchema.ListSessionsResponse),
        ),
      forkSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_fork,
              rpc[AGENT_METHODS.session_fork](payload as AcpSchemaV1.ForkSessionRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.ForkSessionResponse))
          : callRpc(
              AGENT_METHODS.session_fork,
              rpc[AGENT_METHODS.session_fork](toV2ForkRequest(payload)),
            ).pipe(
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(
                    response as AcpSchemaV2.ForkSessionResponse,
                  ) as AcpSchema.ForkSessionResponse,
              ),
            ),
      resumeSession: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](payload as AcpSchemaV1.ResumeSessionRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.ResumeSessionResponse))
          : callRpc(
              AGENT_METHODS.session_resume,
              rpc[AGENT_METHODS.session_resume](
                toV2ResumeRequest(payload, payload.replayFrom ?? undefined),
              ),
            ).pipe(
              Effect.map(
                (response) =>
                  normalizeV2SessionSetupResponse(
                    response as AcpSchemaV2.ResumeSessionResponse,
                  ) as AcpSchema.ResumeSessionResponse,
              ),
            ),
      closeSession: (payload) =>
        callRpc(AGENT_METHODS.session_close, rpc[AGENT_METHODS.session_close](payload)).pipe(
          Effect.map((response) => response as AcpSchema.CloseSessionResponse),
        ),
      deleteSession: (payload) =>
        Effect.suspend(() =>
          sessionDeleteSupported
            ? callRpc(AGENT_METHODS.session_delete, rpc[AGENT_METHODS.session_delete](payload))
            : Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.session_delete)),
        ),
      listProviders: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_list))
          : callRpc(AGENT_METHODS.providers_list, rpc[AGENT_METHODS.providers_list](payload)),
      setProvider: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_set))
          : callRpc(AGENT_METHODS.providers_set, rpc[AGENT_METHODS.providers_set](payload)),
      disableProvider: (payload) =>
        negotiatedProtocolGeneration === 1
          ? Effect.fail(AcpError.AcpRequestError.methodNotFound(AGENT_METHODS.providers_disable))
          : callRpc(AGENT_METHODS.providers_disable, rpc[AGENT_METHODS.providers_disable](payload)),
      setSessionModel: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_set_model,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_set_model](payload),
            )
          : Effect.fail(
              AcpError.AcpRequestError.methodNotFound(AcpRpcs.V1_AGENT_METHODS.session_set_model),
            ),
      setSessionMode: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AcpRpcs.V1_AGENT_METHODS.session_set_mode,
              rpc[AcpRpcs.V1_AGENT_METHODS.session_set_mode](payload),
            )
          : Effect.fail(
              AcpError.AcpRequestError.methodNotFound(AcpRpcs.V1_AGENT_METHODS.session_set_mode),
            ),
      setSessionConfigOption: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_set_config_option,
              rpc[AGENT_METHODS.session_set_config_option](
                payload as AcpSchemaV1.SetSessionConfigOptionRequest,
              ),
            ).pipe(Effect.map((response) => response as AcpSchema.SetSessionConfigOptionResponse))
          : callRpc(
              AGENT_METHODS.session_set_config_option,
              rpc[AGENT_METHODS.session_set_config_option]({
                ...payload,
                type: "type" in payload && payload.type === "boolean" ? "boolean" : "id",
              }),
            ).pipe(
              Effect.map((response) => ({
                configOptions:
                  normalizeConfigOptions(
                    (response as AcpSchemaV2.SetSessionConfigOptionResponse).configOptions,
                  ) ?? [],
              })),
            ),
      prompt: (payload) =>
        negotiatedProtocolGeneration === 1
          ? callRpc(
              AGENT_METHODS.session_prompt,
              rpc[AGENT_METHODS.session_prompt](payload as AcpSchemaV1.PromptRequest),
            ).pipe(Effect.map((response) => response as AcpSchema.PromptResponse))
          : Effect.gen(function* () {
              const existing = promptCompletions.get(payload.sessionId);
              if (existing !== undefined) {
                return yield* AcpError.AcpRequestError.internalError(
                  `ACP session '${payload.sessionId}' already has an active prompt.`,
                );
              }
              const completion = yield* Deferred.make<
                AcpSchema.PromptResponse,
                AcpError.AcpError
              >();
              promptCompletions.set(payload.sessionId, completion);
              return yield* callRpc(
                AGENT_METHODS.session_prompt,
                rpc[AGENT_METHODS.session_prompt](payload as AcpSchemaV2.PromptRequest),
              ).pipe(
                Effect.andThen(Deferred.await(completion)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (promptCompletions.get(payload.sessionId) === completion) {
                      promptCompletions.delete(payload.sessionId);
                    }
                  }),
                ),
              );
            }),
      cancel: (payload) => transport.notify(AGENT_METHODS.session_cancel, payload),
    },
    handleRequestPermission: Effect.fn("AcpClient.handleRequestPermission")(function (handler) {
      return Effect.suspend(() => {
        coreHandlers.requestPermission = handler;
        return Effect.void;
      });
    }),
    handleElicitation: Effect.fn("AcpClient.handleElicitation")(function (handler) {
      return Effect.suspend(() => {
        coreHandlers.elicitation = handler;
        return Effect.void;
      });
    }),
    handleMcpConnect: Effect.fn("AcpClient.handleMcpConnect")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.mcpConnect = handler;
      });
    }),
    handleMcpMessage: Effect.fn("AcpClient.handleMcpMessage")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.mcpMessage = handler;
      });
    }),
    handleMcpDisconnect: Effect.fn("AcpClient.handleMcpDisconnect")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.mcpDisconnect = handler;
      });
    }),
    handleMcpNotification: Effect.fn("AcpClient.handleMcpNotification")(function (handler) {
      return Effect.sync(() => {
        extNotificationHandlers.set(CLIENT_METHODS.mcp_message, (params) =>
          decodeMessageMcpNotification(params).pipe(
            Effect.mapError(() => AcpError.AcpRequestError.invalidParams()),
            Effect.flatMap(handler),
          ),
        );
      });
    }),
    handleReadTextFile: Effect.fn("AcpClient.handleReadTextFile")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.readTextFile = handler;
      });
    }),
    handleWriteTextFile: Effect.fn("AcpClient.handleWriteTextFile")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.writeTextFile = handler;
      });
    }),
    handleCreateTerminal: Effect.fn("AcpClient.handleCreateTerminal")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.createTerminal = handler;
      });
    }),
    handleTerminalOutput: Effect.fn("AcpClient.handleTerminalOutput")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.terminalOutput = handler;
      });
    }),
    handleTerminalWaitForExit: Effect.fn("AcpClient.handleTerminalWaitForExit")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.terminalWaitForExit = handler;
      });
    }),
    handleTerminalKill: Effect.fn("AcpClient.handleTerminalKill")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.terminalKill = handler;
      });
    }),
    handleTerminalRelease: Effect.fn("AcpClient.handleTerminalRelease")(function (handler) {
      return Effect.sync(() => {
        coreHandlers.terminalRelease = handler;
      });
    }),
    handleSessionUpdate: Effect.fn("AcpClient.handleSessionUpdate")(function (handler) {
      return Effect.suspend(() => {
        notificationHandlers.sessionUpdate.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.sessionUpdate);
      });
    }),
    handleElicitationComplete: Effect.fn("AcpClient.handleElicitationComplete")(function (handler) {
      return Effect.suspend(() => {
        notificationHandlers.elicitationComplete.handlers.push(handler);
        return flushBufferedNotifications(notificationHandlers.elicitationComplete);
      });
    }),
    handleUnknownExtRequest: Effect.fn("AcpClient.handleUnknownExtRequest")(function (handler) {
      return Effect.suspend(() => {
        unknownExtRequestHandler = handler;
        return Effect.void;
      });
    }),
    handleUnknownExtNotification: Effect.fn("AcpClient.handleUnknownExtNotification")(
      function (handler) {
        return Effect.suspend(() => {
          unknownExtNotificationHandler = handler;
          return Effect.void;
        });
      },
    ),
    handleExtRequest: Effect.fn("AcpClient.handleExtRequest")(function (method, payload, handler) {
      return Effect.suspend(() => {
        extRequestHandlers.set(method, decodeExtRequestRegistration(method, payload, handler));
        return Effect.void;
      });
    }),
    handleExtNotification: Effect.fn("AcpClient.handleExtNotification")(
      function (method, payload, handler) {
        return Effect.suspend(() => {
          extNotificationHandlers.set(
            method,
            decodeExtNotificationRegistration(method, payload, handler),
          );
          return Effect.void;
        });
      },
    ),
  });
});
