import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DesktopAppConnectionCommand,
  DispatchResult,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderAuthStatus, ServerProviderModel, ServerProviderState } from "./server.ts";

/**
 * Desktop app control socket requests that borrow the renderer's signed-in
 * connection manager on behalf of a local tool (the external T3 MCP server).
 * They share the activation socket and envelope but are handled concurrently
 * and never focus the window.
 */
export const DESKTOP_APP_CONNECTION_PROTOCOL_VERSION = 1 as const;

const RequestBase = {
  version: Schema.Literal(DESKTOP_APP_CONNECTION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("connection"),
};

export const DesktopAppConnectionRequest = Schema.Union([
  Schema.Struct({ ...RequestBase, operation: Schema.Literal("listEnvironments") }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("shell"),
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("thread"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    turnLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    beforeCursor: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("archived"),
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("providers"),
    environmentId: EnvironmentId,
  }),
  Schema.Struct({
    ...RequestBase,
    operation: Schema.Literal("dispatch"),
    environmentId: EnvironmentId,
    command: DesktopAppConnectionCommand,
  }),
]);
export type DesktopAppConnectionRequest = typeof DesktopAppConnectionRequest.Type;
export type DesktopAppConnectionOperation = DesktopAppConnectionRequest["operation"];

export const DesktopAppConnectionEnvironmentStatus = Schema.Literals([
  "connected",
  "connecting",
  "disconnected",
]);
export type DesktopAppConnectionEnvironmentStatus =
  typeof DesktopAppConnectionEnvironmentStatus.Type;

export const DesktopAppConnectionEnvironment = Schema.Struct({
  id: EnvironmentId,
  label: Schema.String,
  status: Schema.optional(DesktopAppConnectionEnvironmentStatus),
});
export type DesktopAppConnectionEnvironment = typeof DesktopAppConnectionEnvironment.Type;

/** Provider summary safe to leave the renderer: no config, credentials, or env. */
export const DesktopAppConnectionProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  installed: Schema.Boolean,
  enabled: Schema.Boolean,
  status: ServerProviderState,
  authStatus: ServerProviderAuthStatus,
  models: Schema.Array(ServerProviderModel),
});
export type DesktopAppConnectionProvider = typeof DesktopAppConnectionProvider.Type;

export const DesktopAppConnectionResult = Schema.Union([
  Schema.Struct({ environments: Schema.Array(DesktopAppConnectionEnvironment) }),
  Schema.Struct({ providers: Schema.Array(DesktopAppConnectionProvider) }),
  DispatchResult,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
]);
export type DesktopAppConnectionResult = typeof DesktopAppConnectionResult.Type;

export const DesktopAppConnectionErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-not-found",
  "environment-unavailable",
  "operation-failed",
  "request-timeout",
  "too-many-requests",
  "internal-error",
]);
export type DesktopAppConnectionErrorCode = typeof DesktopAppConnectionErrorCode.Type;

export const DesktopAppConnectionSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_CONNECTION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  result: DesktopAppConnectionResult,
});
export type DesktopAppConnectionSuccess = typeof DesktopAppConnectionSuccess.Type;

export const DesktopAppConnectionFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_CONNECTION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppConnectionErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppConnectionFailure = typeof DesktopAppConnectionFailure.Type;

export const DesktopAppConnectionResponse = Schema.Union([
  DesktopAppConnectionSuccess,
  DesktopAppConnectionFailure,
]);
export type DesktopAppConnectionResponse = typeof DesktopAppConnectionResponse.Type;

/**
 * IPC envelope between the desktop main process and its renderer. The
 * `dispatchId` is minted per dispatch so a late completion for a reused
 * `requestId` (cancelled, then retried by the caller) can never settle the
 * newer request.
 */
export const DesktopAppConnectionDispatch = Schema.Struct({
  dispatchId: TrimmedNonEmptyString,
  request: DesktopAppConnectionRequest,
});
export type DesktopAppConnectionDispatch = typeof DesktopAppConnectionDispatch.Type;

export const DesktopAppConnectionCompletion = Schema.Struct({
  dispatchId: TrimmedNonEmptyString,
  response: DesktopAppConnectionResponse,
});
export type DesktopAppConnectionCompletion = typeof DesktopAppConnectionCompletion.Type;

export function desktopAppConnectionFailure(
  requestId: string,
  code: DesktopAppConnectionErrorCode,
  message: string,
): DesktopAppConnectionFailure {
  return { version: DESKTOP_APP_CONNECTION_PROTOCOL_VERSION, requestId, ok: false, code, message };
}
