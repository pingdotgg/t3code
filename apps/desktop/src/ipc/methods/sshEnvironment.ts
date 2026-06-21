import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
  isRemoteEnvironmentAuthUndeclaredStatusError,
  RemoteEnvironmentAuthError,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  EnvironmentAuthInvalidError,
  DesktopDiscoveredSshHostSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancellationError,
  DesktopSshPasswordPromptResolutionInputSchema,
  ExecutionEnvironmentDescriptor,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
} from "@t3tools/contracts";
import { SshHttpBridgeError, type SshPasswordPromptError } from "@t3tools/ssh/errors";
import { resolveLoopbackSshHttpBaseUrl } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";

const DesktopSshEnvironmentRequestOperation = Schema.Literals([
  "fetch-environment-descriptor",
  "bootstrap-bearer-session",
  "fetch-session-state",
  "issue-websocket-ticket",
]);
type DesktopSshEnvironmentRequestOperation = typeof DesktopSshEnvironmentRequestOperation.Type;

const DesktopSshEnvironmentRequestCause = Schema.Union([
  RemoteEnvironmentAuthError,
  SshHttpBridgeError,
]);
type DesktopSshEnvironmentRequestCause = typeof DesktopSshEnvironmentRequestCause.Type;

const desktopSshPasswordPromptCancellationReasons = {
  DesktopSshPromptCancelledError: "user-cancelled",
  DesktopSshPromptWindowClosedError: "window-closed",
  DesktopSshPromptServiceStoppedError: "service-stopped",
  DesktopSshPromptTimedOutError: "timed-out",
} as const;

function handleDesktopSshPasswordPromptCancellation(error: SshPasswordPromptError) {
  return DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(error)
    ? Effect.succeed(
        new DesktopSshPasswordPromptCancellationError({
          reason: desktopSshPasswordPromptCancellationReasons[error.cause._tag],
          requestId: error.cause.requestId,
          destination: error.cause.destination,
          cause: error,
        }),
      )
    : Effect.fail(error);
}

const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);
const isEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);
const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const isSshHttpBridgeError = Schema.is(SshHttpBridgeError);

function readSshHttpStatus(cause: DesktopSshEnvironmentRequestCause): number | null {
  if (isRemoteEnvironmentAuthUndeclaredStatusError(cause)) {
    return cause.status ?? null;
  }
  if (isSshHttpBridgeError(cause)) return null;
  if (isEnvironmentRequestInvalidError(cause)) {
    return 400;
  }
  if (isEnvironmentAuthInvalidError(cause)) {
    return 401;
  }
  if (isEnvironmentScopeRequiredError(cause)) {
    return 403;
  }
  if (isEnvironmentOperationForbiddenError(cause)) {
    return 403;
  }
  if (isEnvironmentInternalError(cause)) {
    return 500;
  }
  return null;
}

export class DesktopSshEnvironmentRequestError extends Schema.TaggedErrorClass<DesktopSshEnvironmentRequestError>()(
  "DesktopSshEnvironmentRequestError",
  {
    operation: DesktopSshEnvironmentRequestOperation,
    cause: DesktopSshEnvironmentRequestCause,
    sshHttpStatus: Schema.NullOr(Schema.Number),
  },
) {
  override get message(): string {
    const prefix = this.sshHttpStatus === null ? "" : `[ssh_http:${this.sshHttpStatus}] `;
    return `${prefix}SSH remote API request failed during ${this.operation}.`;
  }
}

const withLoopbackSshApi =
  <A, R>(
    operation: DesktopSshEnvironmentRequestOperation,
    use: (httpBaseUrl: string) => Effect.Effect<A, RemoteEnvironmentAuthError, R>,
  ) =>
  (httpBaseUrl: string): Effect.Effect<A, DesktopSshEnvironmentRequestError, R> =>
    resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.flatMap(use),
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation,
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );

export const discoverSshHosts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopDiscoveredSshHostSchema),
  handler: Effect.fn("desktop.ipc.sshEnvironment.discoverHosts")(function* () {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.discoverHosts();
  }),
});

// Electron forwards only the message from a rejected ipcRenderer.invoke promise to the renderer.
// Preserve typed SSH errors at this boundary so that message stays structural while main-process
// diagnostics retain the exact cause and error fields.
export const ensureSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentEnsureInputSchema,
  result: DesktopSshEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sshEnvironment.ensureEnvironment")(function* ({
    target,
    options,
  }) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    return yield* sshEnvironment.ensureEnvironment(target, options).pipe(
      Effect.catchTags({
        SshPasswordPromptCancelledError: handleDesktopSshPasswordPromptCancellation,
        SshPasswordPromptTimedOutError: handleDesktopSshPasswordPromptCancellation,
        SshPasswordPromptWindowClosedError: handleDesktopSshPasswordPromptCancellation,
        SshPasswordPromptServiceStoppedError: handleDesktopSshPasswordPromptCancellation,
      }),
    );
  }),
});

export const disconnectSshEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL,
  payload: DesktopSshEnvironmentTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.disconnectEnvironment")(function* (target) {
    const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
    yield* sshEnvironment.disconnectEnvironment(target);
  }),
});

export const fetchSshEnvironmentDescriptor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL,
  payload: DesktopSshHttpBaseUrlInputSchema,
  result: ExecutionEnvironmentDescriptor,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchDescriptor")(function* ({ httpBaseUrl }) {
    return yield* withLoopbackSshApi("fetch-environment-descriptor", (resolvedHttpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
  }),
});

export const bootstrapSshBearerSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL,
  payload: DesktopSshBearerBootstrapInputSchema,
  result: AuthAccessTokenResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.bootstrapBearerSession")(function* ({
    httpBaseUrl,
    credential,
  }) {
    return yield* withLoopbackSshApi("bootstrap-bearer-session", (resolvedHttpBaseUrl) =>
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedHttpBaseUrl,
        credential,
      }),
    )(httpBaseUrl);
  }),
});

export const fetchSshSessionState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthSessionState,
  handler: Effect.fn("desktop.ipc.sshEnvironment.fetchSessionState")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("fetch-session-state", (resolvedHttpBaseUrl) =>
      fetchRemoteSessionState({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const issueSshWebSocketTicket = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL,
  payload: DesktopSshBearerRequestInputSchema,
  result: AuthWebSocketTicketResult,
  handler: Effect.fn("desktop.ipc.sshEnvironment.issueWebSocketTicket")(function* ({
    httpBaseUrl,
    bearerToken,
  }) {
    return yield* withLoopbackSshApi("issue-websocket-ticket", (resolvedHttpBaseUrl) =>
      issueRemoteWebSocketTicket({
        httpBaseUrl: resolvedHttpBaseUrl,
        bearerToken,
      }),
    )(httpBaseUrl);
  }),
});

export const resolveSshPasswordPrompt = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL,
  payload: DesktopSshPasswordPromptResolutionInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sshEnvironment.resolvePasswordPrompt")(function* ({
    requestId,
    password,
  }) {
    const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
    yield* prompts.resolve({ requestId, password });
  }),
});
