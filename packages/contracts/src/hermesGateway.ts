/**
 * Versioned contracts for the T3 Code gateway plugin hosted by Hermes.
 *
 * The web-management schemas are intentionally separate from the plugin wire
 * protocol. Browser clients may receive one-time enrollment tokens, but never
 * the persistent credential issued directly to the plugin after enrollment.
 *
 * @module hermesGateway
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderApprovalDecision, ProviderUserInputAnswers } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { CanonicalItemType, CanonicalRequestType, UserInputQuestion } from "./providerRuntime.ts";

export const HERMES_GATEWAY_PROTOCOL_VERSION = 1 as const;

export const HermesGatewayProtocolVersion = Schema.Literal(HERMES_GATEWAY_PROTOCOL_VERSION);
export type HermesGatewayProtocolVersion = typeof HermesGatewayProtocolVersion.Type;

export const HermesGatewayRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("HermesGatewayRequestId"),
);
export type HermesGatewayRequestId = typeof HermesGatewayRequestId.Type;

/**
 * An opaque identifier owned entirely by Hermes. T3 persists and echoes it,
 * but must not derive routing or other semantics from its contents.
 */
export const HermesGatewaySessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("HermesGatewaySessionId"),
);
export type HermesGatewaySessionId = typeof HermesGatewaySessionId.Type;

export const HermesGatewayResumeCursor = Schema.Struct({
  protocolVersion: HermesGatewayProtocolVersion,
  sessionId: HermesGatewaySessionId,
});
export type HermesGatewayResumeCursor = typeof HermesGatewayResumeCursor.Type;

export const HermesGatewayItemId = TrimmedNonEmptyString.pipe(Schema.brand("HermesGatewayItemId"));
export type HermesGatewayItemId = typeof HermesGatewayItemId.Type;

export const HermesGatewayEnrollmentToken = TrimmedNonEmptyString.pipe(
  Schema.brand("HermesGatewayEnrollmentToken"),
);
export type HermesGatewayEnrollmentToken = typeof HermesGatewayEnrollmentToken.Type;

export const HermesGatewayCredential = TrimmedNonEmptyString.pipe(
  Schema.brand("HermesGatewayCredential"),
);
export type HermesGatewayCredential = typeof HermesGatewayCredential.Type;

export const HermesGatewayNickname = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type HermesGatewayNickname = typeof HermesGatewayNickname.Type;

/**
 * T3 accepts ordinary HTTP(S) URLs because the plugin command may normalize
 * them to WebSocket URLs, as well as explicit WS(S) connector URLs.
 */
export const HermesGatewayConnectorUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^(?:https?|wss?):\/\/\S+$/i),
);
export type HermesGatewayConnectorUrl = typeof HermesGatewayConnectorUrl.Type;

export const HermesGatewayCapabilities = Schema.Struct({
  protocolVersion: HermesGatewayProtocolVersion,
  streaming: Schema.Boolean,
  activity: Schema.Boolean,
  approvals: Schema.Boolean,
  userInput: Schema.Boolean,
  attachments: Schema.Literal(false),
});
export type HermesGatewayCapabilities = typeof HermesGatewayCapabilities.Type;

/**
 * Capability advertisement accepted at the initial handshake boundary.
 *
 * This deliberately permits capability shapes from a newer protocol so T3 can
 * return a structured `version-incompatible` rejection instead of failing the
 * WebSocket frame decoder. Accepted v1 connections must subsequently validate
 * this advertisement with `HermesGatewayCapabilities`.
 */
export const HermesGatewayHelloCapabilities = Schema.Struct({
  protocolVersion: PositiveInt,
  streaming: Schema.Boolean,
  activity: Schema.Boolean,
  approvals: Schema.Boolean,
  userInput: Schema.Boolean,
  attachments: Schema.Boolean,
});
export type HermesGatewayHelloCapabilities = typeof HermesGatewayHelloCapabilities.Type;

export const HermesGatewayConnectionState = Schema.Literals([
  "offline",
  "connecting",
  "connected",
  "upgrade-required",
  "revoked",
]);
export type HermesGatewayConnectionState = typeof HermesGatewayConnectionState.Type;

/**
 * Public instance state used by settings and provider-picker surfaces.
 *
 * `protocolVersion` is not restricted to v1 here so the UI can report the
 * unsupported version observed from a plugin that needs an upgrade.
 */
export const HermesGatewayInstanceStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
  status: HermesGatewayConnectionState,
  connectorUrl: HermesGatewayConnectorUrl,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  pluginVersion: Schema.NullOr(TrimmedNonEmptyString),
  hermesVersion: Schema.NullOr(TrimmedNonEmptyString),
  activeSessionCount: NonNegativeInt,
  protocolVersion: Schema.NullOr(PositiveInt),
  capabilities: Schema.NullOr(HermesGatewayCapabilities),
});
export type HermesGatewayInstanceStatus = typeof HermesGatewayInstanceStatus.Type;

export const HermesGatewayCreateEnrollmentInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
  connectorUrl: HermesGatewayConnectorUrl,
});
export type HermesGatewayCreateEnrollmentInput = typeof HermesGatewayCreateEnrollmentInput.Type;

/**
 * Returned exactly once to the web client. The long-lived plugin credential
 * is intentionally absent and is delivered only over the authenticated
 * enrollment socket.
 */
export const HermesGatewayEnrollmentResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  expiresAt: IsoDateTime,
  connectorUrl: HermesGatewayConnectorUrl,
  command: TrimmedNonEmptyString,
  oneTimeToken: HermesGatewayEnrollmentToken,
});
export type HermesGatewayEnrollmentResult = typeof HermesGatewayEnrollmentResult.Type;

export const HermesGatewayListInstancesResult = Schema.Array(HermesGatewayInstanceStatus);
export type HermesGatewayListInstancesResult = typeof HermesGatewayListInstancesResult.Type;

export const HermesGatewayGetInstanceStatusInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type HermesGatewayGetInstanceStatusInput = typeof HermesGatewayGetInstanceStatusInput.Type;

export const HermesGatewayRenameInstanceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
});
export type HermesGatewayRenameInstanceInput = typeof HermesGatewayRenameInstanceInput.Type;

export const HermesGatewayRenameInstanceResult = HermesGatewayInstanceStatus;
export type HermesGatewayRenameInstanceResult = typeof HermesGatewayRenameInstanceResult.Type;

export const HermesGatewayRevokeInstanceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type HermesGatewayRevokeInstanceInput = typeof HermesGatewayRevokeInstanceInput.Type;

export const HermesGatewayRevokeInstanceResult = HermesGatewayInstanceStatus;
export type HermesGatewayRevokeInstanceResult = typeof HermesGatewayRevokeInstanceResult.Type;

export const HermesGatewayRemoveInstanceInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type HermesGatewayRemoveInstanceInput = typeof HermesGatewayRemoveInstanceInput.Type;

export const HermesGatewayRemoveInstanceResult = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type HermesGatewayRemoveInstanceResult = typeof HermesGatewayRemoveInstanceResult.Type;

export const HermesGatewayManagementOperation = Schema.Literals([
  "create-enrollment",
  "get-status",
  "list-instances",
  "rename-instance",
  "revoke-instance",
  "remove-instance",
]);
export type HermesGatewayManagementOperation = typeof HermesGatewayManagementOperation.Type;

export const HermesGatewayManagementErrorCode = Schema.Literals([
  "instance-not-found",
  "nickname-conflict",
  "invalid-connector-url",
  "instance-revoked",
  "instance-removed",
  "instance-not-revoked",
  "persistence-failed",
  "internal-error",
]);
export type HermesGatewayManagementErrorCode = typeof HermesGatewayManagementErrorCode.Type;

export class HermesGatewayManagementError extends Schema.TaggedErrorClass<HermesGatewayManagementError>()(
  "HermesGatewayManagementError",
  {
    operation: HermesGatewayManagementOperation,
    code: HermesGatewayManagementErrorCode,
    message: TrimmedNonEmptyString,
    instanceId: Schema.optional(ProviderInstanceId),
  },
) {}

const HermesGatewayEnrollmentAuthentication = Schema.Struct({
  type: Schema.Literal("enrollment-token"),
  token: HermesGatewayEnrollmentToken,
});
export type HermesGatewayEnrollmentAuthentication =
  typeof HermesGatewayEnrollmentAuthentication.Type;

const HermesGatewayCredentialAuthentication = Schema.Struct({
  type: Schema.Literal("instance-credential"),
  instanceId: ProviderInstanceId,
  credential: HermesGatewayCredential,
});
export type HermesGatewayCredentialAuthentication =
  typeof HermesGatewayCredentialAuthentication.Type;

export const HermesGatewayAuthentication = Schema.Union([
  HermesGatewayEnrollmentAuthentication,
  HermesGatewayCredentialAuthentication,
]);
export type HermesGatewayAuthentication = typeof HermesGatewayAuthentication.Type;

/**
 * `protocolVersion` accepts any positive integer at the initial boundary so
 * T3 can reject incompatible plugins with a structured upgrade response.
 * Once accepted, all remaining v1 frames use the literal v1 schema.
 */
export const HermesGatewayConnectionHello = Schema.Struct({
  type: Schema.Literal("connection.hello"),
  requestId: HermesGatewayRequestId,
  protocolVersion: PositiveInt,
  pluginVersion: TrimmedNonEmptyString,
  hermesVersion: TrimmedNonEmptyString,
  capabilities: HermesGatewayHelloCapabilities,
  authentication: HermesGatewayAuthentication,
});
export type HermesGatewayConnectionHello = typeof HermesGatewayConnectionHello.Type;

export const HermesGatewayConnectionAccepted = Schema.Struct({
  type: Schema.Literal("connection.accepted"),
  requestId: HermesGatewayRequestId,
  protocolVersion: HermesGatewayProtocolVersion,
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
  credential: Schema.optional(HermesGatewayCredential),
});
export type HermesGatewayConnectionAccepted = typeof HermesGatewayConnectionAccepted.Type;

export const HermesGatewayConnectionRejectionCode = Schema.Literals([
  "invalid-authentication",
  "enrollment-expired",
  "instance-revoked",
  "version-incompatible",
  "internal-error",
]);
export type HermesGatewayConnectionRejectionCode = typeof HermesGatewayConnectionRejectionCode.Type;

export const HermesGatewayConnectionRejected = Schema.Struct({
  type: Schema.Literal("connection.rejected"),
  requestId: HermesGatewayRequestId,
  code: HermesGatewayConnectionRejectionCode,
  message: TrimmedNonEmptyString,
  expectedProtocolVersion: HermesGatewayProtocolVersion,
});
export type HermesGatewayConnectionRejected = typeof HermesGatewayConnectionRejected.Type;

export const HermesGatewayConnectionStatus = Schema.Struct({
  type: Schema.Literal("connection.status"),
  protocolVersion: HermesGatewayProtocolVersion,
  activeSessionCount: NonNegativeInt,
});
export type HermesGatewayConnectionStatus = typeof HermesGatewayConnectionStatus.Type;

const HermesGatewaySessionContext = Schema.Struct({
  threadId: ThreadId,
  sessionId: HermesGatewaySessionId,
});

const HermesGatewayTurnContext = Schema.Struct({
  ...HermesGatewaySessionContext.fields,
  turnId: TurnId,
});

const HermesGatewayTurnText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120_000),
);

export const HermesGatewaySessionEnsure = Schema.Struct({
  type: Schema.Literal("session.ensure"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  threadId: ThreadId,
  resumeSessionId: Schema.optional(HermesGatewaySessionId),
});
export type HermesGatewaySessionEnsure = typeof HermesGatewaySessionEnsure.Type;

export const HermesGatewayTurnStart = Schema.Struct({
  type: Schema.Literal("turn.start"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
  text: HermesGatewayTurnText,
});
export type HermesGatewayTurnStart = typeof HermesGatewayTurnStart.Type;

export const HermesGatewayTurnSteer = Schema.Struct({
  type: Schema.Literal("turn.steer"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
  text: HermesGatewayTurnText,
});
export type HermesGatewayTurnSteer = typeof HermesGatewayTurnSteer.Type;

export const HermesGatewayTurnInterrupt = Schema.Struct({
  type: Schema.Literal("turn.interrupt"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
});
export type HermesGatewayTurnInterrupt = typeof HermesGatewayTurnInterrupt.Type;

export const HermesGatewayApprovalResponse = Schema.Struct({
  type: Schema.Literal("approval.respond"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  requestId: HermesGatewayRequestId,
  decision: ProviderApprovalDecision,
});
export type HermesGatewayApprovalResponse = typeof HermesGatewayApprovalResponse.Type;

export const HermesGatewayUserInputResponse = Schema.Struct({
  type: Schema.Literal("user-input.respond"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  requestId: HermesGatewayRequestId,
  answers: ProviderUserInputAnswers,
});
export type HermesGatewayUserInputResponse = typeof HermesGatewayUserInputResponse.Type;

export const HermesGatewaySessionStop = Schema.Struct({
  type: Schema.Literal("session.stop"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewaySessionContext.fields,
});
export type HermesGatewaySessionStop = typeof HermesGatewaySessionStop.Type;

export const HermesGatewayPing = Schema.Struct({
  type: Schema.Literal("ping"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  sentAt: IsoDateTime,
});
export type HermesGatewayPing = typeof HermesGatewayPing.Type;

export const HermesGatewaySessionReady = Schema.Struct({
  type: Schema.Literal("session.ready"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  threadId: ThreadId,
  sessionId: HermesGatewaySessionId,
  resumed: Schema.Boolean,
});
export type HermesGatewaySessionReady = typeof HermesGatewaySessionReady.Type;

export const HermesGatewayTurnStarted = Schema.Struct({
  type: Schema.Literal("turn.started"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
});
export type HermesGatewayTurnStarted = typeof HermesGatewayTurnStarted.Type;

export const HermesGatewayContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "unknown",
]);
export type HermesGatewayContentStreamKind = typeof HermesGatewayContentStreamKind.Type;

export const HermesGatewayContentDelta = Schema.Struct({
  type: Schema.Literal("content.delta"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  itemId: Schema.optional(HermesGatewayItemId),
  streamKind: HermesGatewayContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(NonNegativeInt),
});
export type HermesGatewayContentDelta = typeof HermesGatewayContentDelta.Type;

export const HermesGatewayItemStatus = Schema.Literals([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
export type HermesGatewayItemStatus = typeof HermesGatewayItemStatus.Type;

const HermesGatewayItemLifecycleFields = {
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  itemId: HermesGatewayItemId,
  itemType: CanonicalItemType,
  status: Schema.optional(HermesGatewayItemStatus),
  title: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  data: Schema.optional(Schema.Unknown),
};

export const HermesGatewayItemStarted = Schema.Struct({
  type: Schema.Literal("item.started"),
  ...HermesGatewayItemLifecycleFields,
});
export type HermesGatewayItemStarted = typeof HermesGatewayItemStarted.Type;

export const HermesGatewayItemUpdated = Schema.Struct({
  type: Schema.Literal("item.updated"),
  ...HermesGatewayItemLifecycleFields,
});
export type HermesGatewayItemUpdated = typeof HermesGatewayItemUpdated.Type;

export const HermesGatewayItemCompleted = Schema.Struct({
  type: Schema.Literal("item.completed"),
  ...HermesGatewayItemLifecycleFields,
});
export type HermesGatewayItemCompleted = typeof HermesGatewayItemCompleted.Type;

const HermesGatewayInteractionContext = Schema.Struct({
  ...HermesGatewayTurnContext.fields,
  requestId: HermesGatewayRequestId,
});

export const HermesGatewayRequestOpened = Schema.Struct({
  type: Schema.Literal("request.opened"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayInteractionContext.fields,
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Unknown),
});
export type HermesGatewayRequestOpened = typeof HermesGatewayRequestOpened.Type;

export const HermesGatewayRequestResolved = Schema.Struct({
  type: Schema.Literal("request.resolved"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayInteractionContext.fields,
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyString),
  resolution: Schema.optional(Schema.Unknown),
});
export type HermesGatewayRequestResolved = typeof HermesGatewayRequestResolved.Type;

export const HermesGatewayUserInputRequested = Schema.Struct({
  type: Schema.Literal("user-input.requested"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayInteractionContext.fields,
  questions: Schema.Array(UserInputQuestion),
});
export type HermesGatewayUserInputRequested = typeof HermesGatewayUserInputRequested.Type;

export const HermesGatewayUserInputResolved = Schema.Struct({
  type: Schema.Literal("user-input.resolved"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayInteractionContext.fields,
  answers: ProviderUserInputAnswers,
});
export type HermesGatewayUserInputResolved = typeof HermesGatewayUserInputResolved.Type;

export const HermesGatewayTurnCompletionState = Schema.Literals(["completed", "failed"]);
export type HermesGatewayTurnCompletionState = typeof HermesGatewayTurnCompletionState.Type;

export const HermesGatewayTurnCompleted = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  state: HermesGatewayTurnCompletionState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  usage: Schema.optional(Schema.Unknown),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
});
export type HermesGatewayTurnCompleted = typeof HermesGatewayTurnCompleted.Type;

export const HermesGatewayTurnAborted = Schema.Struct({
  type: Schema.Literal("turn.aborted"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  reason: TrimmedNonEmptyString,
});
export type HermesGatewayTurnAborted = typeof HermesGatewayTurnAborted.Type;

export const HermesGatewaySessionExited = Schema.Struct({
  type: Schema.Literal("session.exited"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewaySessionContext.fields,
  reason: Schema.optional(TrimmedNonEmptyString),
  recoverable: Schema.Boolean,
});
export type HermesGatewaySessionExited = typeof HermesGatewaySessionExited.Type;

export const HermesGatewayPong = Schema.Struct({
  type: Schema.Literal("pong"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  sentAt: IsoDateTime,
});
export type HermesGatewayPong = typeof HermesGatewayPong.Type;

export const HermesGatewayProtocolErrorCode = Schema.Literals([
  "invalid-message",
  "unsupported-message",
  "session-not-found",
  "turn-not-active",
  "request-not-found",
  "internal-error",
]);
export type HermesGatewayProtocolErrorCode = typeof HermesGatewayProtocolErrorCode.Type;

export const HermesGatewayProtocolError = Schema.Struct({
  type: Schema.Literal("protocol.error"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: Schema.optional(HermesGatewayRequestId),
  code: HermesGatewayProtocolErrorCode,
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});
export type HermesGatewayProtocolError = typeof HermesGatewayProtocolError.Type;

export const HermesGatewayT3ToPluginMessage = Schema.Union([
  HermesGatewayConnectionAccepted,
  HermesGatewayConnectionRejected,
  HermesGatewaySessionEnsure,
  HermesGatewayTurnStart,
  HermesGatewayTurnSteer,
  HermesGatewayTurnInterrupt,
  HermesGatewayApprovalResponse,
  HermesGatewayUserInputResponse,
  HermesGatewaySessionStop,
  HermesGatewayPing,
]);
export type HermesGatewayT3ToPluginMessage = typeof HermesGatewayT3ToPluginMessage.Type;

export const HermesGatewayPluginToT3Message = Schema.Union([
  HermesGatewayConnectionHello,
  HermesGatewayConnectionStatus,
  HermesGatewaySessionReady,
  HermesGatewayTurnStarted,
  HermesGatewayContentDelta,
  HermesGatewayItemStarted,
  HermesGatewayItemUpdated,
  HermesGatewayItemCompleted,
  HermesGatewayRequestOpened,
  HermesGatewayRequestResolved,
  HermesGatewayUserInputRequested,
  HermesGatewayUserInputResolved,
  HermesGatewayTurnCompleted,
  HermesGatewayTurnAborted,
  HermesGatewaySessionExited,
  HermesGatewayPong,
  HermesGatewayProtocolError,
]);
export type HermesGatewayPluginToT3Message = typeof HermesGatewayPluginToT3Message.Type;

export const HermesGatewayWireMessage = Schema.Union([
  HermesGatewayT3ToPluginMessage,
  HermesGatewayPluginToT3Message,
]);
export type HermesGatewayWireMessage = typeof HermesGatewayWireMessage.Type;
