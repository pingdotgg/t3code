import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpError from "./errors.ts";
import * as AcpProtocol from "./protocol.ts";
import * as AcpSchema from "./compat.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";
import type { AcpClientOptions, AcpClientRaw, AcpRequestHandler } from "./clientPart2.ts";
import { make } from "./clientPart6.ts";
export type {
  AcpClientOptions,
  AcpRequestHandler,
} from "./clientPart2.ts";
export { make } from "./clientPart6.ts";

export class AcpClient extends Context.Service<
  AcpClient,
  {
    readonly raw: AcpClientRaw;
    readonly agent: {
      readonly initialize: (
        payload: AcpSchema.InitializeRequest,
      ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
      readonly authenticate: (
        payload: AcpSchema.AuthenticateRequest,
      ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
      readonly logout: (
        payload: AcpSchema.LogoutRequest,
      ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
      readonly createSession: (
        payload: AcpSchema.NewSessionRequest,
      ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
      /**
       * This compatibility name maps to ACP v2's `session/resume`; v2 removed
       * `session/load` and expresses replay with `replayFrom`.
       */
      readonly loadSession: (
        payload: AcpSchema.LoadSessionRequest,
      ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
      readonly listSessions: (
        payload: AcpSchema.ListSessionsRequest,
      ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
      readonly forkSession: (
        payload: AcpSchema.ForkSessionRequest,
      ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
      readonly resumeSession: (
        payload: AcpSchema.ResumeSessionRequest,
      ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
      readonly closeSession: (
        payload: AcpSchema.CloseSessionRequest,
      ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
      readonly deleteSession: (
        payload: AcpSchema.DeleteSessionRequest,
      ) => Effect.Effect<AcpSchema.DeleteSessionResponse, AcpError.AcpError>;
      readonly listProviders: (
        payload: AcpSchema.ListProvidersRequest,
      ) => Effect.Effect<AcpSchema.ListProvidersResponse, AcpError.AcpError>;
      readonly setProvider: (
        payload: AcpSchema.SetProviderRequest,
      ) => Effect.Effect<AcpSchema.SetProviderResponse, AcpError.AcpError>;
      readonly disableProvider: (
        payload: AcpSchema.DisableProviderRequest,
      ) => Effect.Effect<AcpSchema.DisableProviderResponse, AcpError.AcpError>;
      readonly setSessionModel: (
        payload: AcpSchema.SetSessionModelRequest,
      ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
      /**
       * Selects a session mode on ACP v1 agents, which predate mode config
       * options. ACP v2 fails with method-not-found; use `setSessionConfigOption`.
       */
      readonly setSessionMode: (
        payload: AcpSchemaV1.SetSessionModeRequest,
      ) => Effect.Effect<AcpSchemaV1.SetSessionModeResponse, AcpError.AcpError>;
      readonly setSessionConfigOption: (
        payload: AcpSchema.SetSessionConfigOptionRequest,
      ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
      readonly prompt: (
        payload: AcpSchema.PromptRequest,
      ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
      readonly cancel: (
        payload: AcpSchema.CancelNotification,
      ) => Effect.Effect<void, AcpError.AcpError>;
    };
    readonly handleRequestPermission: (
      handler: AcpRequestHandler<
        AcpSchema.RequestPermissionRequest,
        AcpSchema.RequestPermissionResponse
      >,
    ) => Effect.Effect<void>;
    readonly handleElicitation: (
      handler: AcpRequestHandler<
        AcpSchema.CreateElicitationRequest,
        AcpSchema.CreateElicitationResponse
      >,
    ) => Effect.Effect<void>;
    readonly handleMcpConnect: (
      handler: AcpRequestHandler<AcpSchema.ConnectMcpRequest, AcpSchema.ConnectMcpResponse>,
    ) => Effect.Effect<void>;
    readonly handleMcpMessage: (
      handler: AcpRequestHandler<AcpSchema.MessageMcpRequest, AcpSchema.MessageMcpResponse>,
    ) => Effect.Effect<void>;
    readonly handleMcpDisconnect: (
      handler: AcpRequestHandler<AcpSchema.DisconnectMcpRequest, AcpSchema.DisconnectMcpResponse>,
    ) => Effect.Effect<void>;
    readonly handleMcpNotification: (
      handler: (
        notification: AcpSchema.MessageMcpNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    readonly handleReadTextFile: (
      handler: AcpRequestHandler<AcpSchema.ReadTextFileRequest, AcpSchema.ReadTextFileResponse>,
    ) => Effect.Effect<void>;
    readonly handleWriteTextFile: (
      handler: AcpRequestHandler<
        AcpSchema.WriteTextFileRequest,
        AcpSchema.WriteTextFileResponse | void
      >,
    ) => Effect.Effect<void>;
    readonly handleCreateTerminal: (
      handler: AcpRequestHandler<AcpSchema.CreateTerminalRequest, AcpSchema.CreateTerminalResponse>,
    ) => Effect.Effect<void>;
    readonly handleTerminalOutput: (
      handler: AcpRequestHandler<AcpSchema.TerminalOutputRequest, AcpSchema.TerminalOutputResponse>,
    ) => Effect.Effect<void>;
    readonly handleTerminalWaitForExit: (
      handler: AcpRequestHandler<
        AcpSchema.WaitForTerminalExitRequest,
        AcpSchema.WaitForTerminalExitResponse
      >,
    ) => Effect.Effect<void>;
    readonly handleTerminalKill: (
      handler: AcpRequestHandler<
        AcpSchema.KillTerminalRequest,
        AcpSchema.KillTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    readonly handleTerminalRelease: (
      handler: AcpRequestHandler<
        AcpSchema.ReleaseTerminalRequest,
        AcpSchema.ReleaseTerminalResponse | void
      >,
    ) => Effect.Effect<void>;
    readonly handleSessionUpdate: (
      handler: (
        notification: AcpSchema.SessionNotification,
      ) => Effect.Effect<void, AcpError.AcpError>,
    ) => Effect.Effect<void>;
    readonly handleElicitationComplete: (
      handler: (
        notification: AcpSchema.CompleteElicitationNotification,
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
>()("effect-acp/client/AcpClient") {}

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpClientOptions = {},
): Layer.Layer<AcpClient> => {
  const stdio = {
    ...makeChildStdio(handle),
    stdin: options.transformStdout?.(handle.stdout) ?? handle.stdout,
  };
  const terminationError = makeTerminationError(handle);
  return Layer.effect(AcpClient, make(stdio, options, terminationError));
};
