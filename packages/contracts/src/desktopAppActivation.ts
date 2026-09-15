import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

/** The activation operations a desktop shell can advertise. */
export const DesktopAppActivationOperation = Schema.Literals(["open-workspace", "open-thread"]);
export type DesktopAppActivationOperation = typeof DesktopAppActivationOperation.Type;

/** Existing open-a-workspace request. Kept byte-for-byte compatible with protocol v1. */
export const DesktopAppOpenWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export type DesktopAppOpenWorkspaceRequest = typeof DesktopAppOpenWorkspaceRequest.Type;

/**
 * Opens an existing conversation in the desktop's primary environment. The
 * environmentId is the client's chosen target, not a hint: the renderer
 * rejects a mismatch instead of substituting its primary.
 */
export const DesktopAppOpenThreadRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-thread"),
  platform: DesktopAppActivationPlatform,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type DesktopAppOpenThreadRequest = typeof DesktopAppOpenThreadRequest.Type;

export const DesktopAppActivationRequest = Schema.Union([
  DesktopAppOpenWorkspaceRequest,
  DesktopAppOpenThreadRequest,
]);
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

/**
 * Read-only capability probe. Separate from activation so a shell can answer
 * it without focusing a window, touching the renderer, or creating anything.
 */
export const DesktopAppGetCapabilitiesRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("get-capabilities"),
});
export type DesktopAppGetCapabilitiesRequest = typeof DesktopAppGetCapabilitiesRequest.Type;

/** Everything a connected control client may send over the local socket. */
export const DesktopAppControlRequest = Schema.Union([
  DesktopAppActivationRequest,
  DesktopAppGetCapabilitiesRequest,
]);
export type DesktopAppControlRequest = typeof DesktopAppControlRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-not-found",
  "thread-open-failed",
  "request-superseded",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  // Absent for open-workspace responses so existing v1 workspace clients
  // decode them unchanged; always present for open-thread.
  environmentId: Schema.optional(EnvironmentId),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

/** Activation-only response union. Capability responses intentionally sit outside it. */
export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;

export const DesktopAppCapabilitiesSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  type: Schema.Literal("capabilities"),
  operations: Schema.Array(DesktopAppActivationOperation),
  environmentScope: Schema.Literal("primary"),
});
export type DesktopAppCapabilitiesSuccess = typeof DesktopAppCapabilitiesSuccess.Type;

export const DesktopAppControlResponse = Schema.Union([
  DesktopAppActivationResponse,
  DesktopAppCapabilitiesSuccess,
]);
export type DesktopAppControlResponse = typeof DesktopAppControlResponse.Type;
