/**
 * Versioned contracts for the T3 Code gateway plugin hosted by Hermes.
 *
 * The web-management schemas are intentionally separate from the plugin wire
 * protocol. Browser clients may receive one-time enrollment tokens, but never
 * the persistent credential issued directly to the plugin after enrollment.
 *
 * @module hermesGateway
 */
import * as Effect from "effect/Effect";
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

export const HERMES_GATEWAY_PROTOCOL_VERSION = 5 as const;

/**
 * Base64 payload ceiling for a single media frame, both directions.
 *
 * 25MB of raw bytes is ~34MB of base64; the schema bound is on the encoded
 * string so an oversized frame fails at decode rather than after buffering.
 * Deliberately no chunking protocol — a file that does not fit does not
 * send, with a clear error. Chunking is the escape hatch if that ceiling
 * ever genuinely hurts.
 */
export const HERMES_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const HERMES_MEDIA_MAX_BASE64_CHARS = Math.ceil(HERMES_MEDIA_MAX_BYTES / 3) * 4 + 4;

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
  // Literal by design: attachments are part of the current contract, not a
  // negotiated option. A plugin speaking v5 must handle them; one that cannot
  // is a pre-v4 plugin and is rejected at the version gate.
  attachments: Schema.Literal(true),
});
export type HermesGatewayCapabilities = typeof HermesGatewayCapabilities.Type;

/**
 * Capability advertisement accepted at the initial handshake boundary.
 *
 * This deliberately permits capability shapes from a newer protocol so T3 can
 * return a structured `version-incompatible` rejection instead of failing the
 * WebSocket frame decoder. Accepted connections must subsequently validate
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
 * `protocolVersion` is not restricted to the current version here so the UI
 * can report the unsupported version observed from a plugin that needs an
 * upgrade.
 */
export const HermesGatewayInstanceStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
  status: HermesGatewayConnectionState,
  connectorUrl: HermesGatewayConnectorUrl,
  lastConnectedAt: Schema.NullOr(IsoDateTime),
  pluginVersion: Schema.NullOr(TrimmedNonEmptyString),
  hermesVersion: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The model the connected plugin reported at handshake, surfaced so the
   * provider picker can name the model Hermes actually runs instead of a
   * placeholder. Null when no plugin has connected yet, or when the connected
   * plugin predates the `model` field on `connection.hello`.
   */
  model: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Monotonic id of the underlying connection, or null while offline.
   *
   * Consumers must key "this is a different plugin process now" off this
   * rather than off `status` transitioning through `offline`. A replacement —
   * the old socket dying as a new one is accepted — publishes a single
   * `connected` status, so a connectedness edge detector never fires and
   * anything that must be re-established per connection (notably
   * `session.ensure`) is silently skipped.
   */
  connectionGeneration: Schema.NullOr(NonNegativeInt),
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
 * What a connecting socket intends to be.
 *
 * `gateway` is the instance's one live plugin connection: registered under
 * generation fencing, pinged for liveness, and displacing any predecessor.
 * `delivery` is a short-lived socket — an out-of-process cron run dialing in
 * only to hand over a `home.deliver` and leave. Delivery connections are
 * authenticated identically but are never registered as the primary
 * connection, so they cannot kick a healthy gateway socket off its instance.
 */
export const HermesGatewayConnectionRole = Schema.Literals(["gateway", "delivery"]);
export type HermesGatewayConnectionRole = typeof HermesGatewayConnectionRole.Type;

/**
 * `protocolVersion` accepts any positive integer at the initial boundary so
 * T3 can reject incompatible plugins with a structured upgrade response.
 * Once accepted, all remaining frames use the literal current-version schema.
 */
export const HermesGatewayConnectionHello = Schema.Struct({
  type: Schema.Literal("connection.hello"),
  requestId: HermesGatewayRequestId,
  protocolVersion: PositiveInt,
  pluginVersion: TrimmedNonEmptyString,
  hermesVersion: TrimmedNonEmptyString,
  capabilities: HermesGatewayHelloCapabilities,
  authentication: HermesGatewayAuthentication,
  /**
   * The model Hermes is configured to run, reported as a lightweight handshake
   * summary. T3 requests the selectable catalog after connecting.
   *
   * Optional so a plugin that predates this field still connects: an absent
   * value degrades to the generic label rather than failing the handshake.
   */
  model: Schema.optional(TrimmedNonEmptyString),
  /**
   * Defaults to `"gateway"` on decode so the field stays honest about intent
   * rather than making every caller repeat the common case. Protocol changes
   * require both sides updated regardless, so this default is ergonomics, not
   * tolerance.
   */
  role: HermesGatewayConnectionRole.pipe(Schema.withDecodingDefault(Effect.succeed("gateway"))),
});
export type HermesGatewayConnectionHello = typeof HermesGatewayConnectionHello.Type;

export const HermesGatewayConnectionAccepted = Schema.Struct({
  type: Schema.Literal("connection.accepted"),
  requestId: HermesGatewayRequestId,
  protocolVersion: HermesGatewayProtocolVersion,
  instanceId: ProviderInstanceId,
  nickname: HermesGatewayNickname,
  credential: Schema.optional(HermesGatewayCredential),
  /**
   * The instance's durable home thread — where Hermes' proactive output lands
   * when nothing named a destination. Sent on every successful handshake so
   * the plugin reconciles its `T3_HOME_CHANNEL` cache each connect; T3's
   * settings blob is the authoritative designation.
   *
   * Optional because resolving it must never fail a handshake: if the thread
   * could not be created this connect, the plugin keeps whatever it had and
   * reconciles on the next one.
   */
  homeThreadId: Schema.optional(ThreadId),
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

export const HermesGatewayReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type HermesGatewayReasoningEffort = typeof HermesGatewayReasoningEffort.Type;

const HermesGatewayDefaultModelSelection = Schema.Struct({
  mode: Schema.Literal("default"),
});

const HermesGatewaySpecificModelSelection = Schema.Struct({
  mode: Schema.Literal("specific"),
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
});

/** A turn's requested model, before Hermes resolves its configured default. */
export const HermesGatewayRequestedModelSelection = Schema.Union([
  HermesGatewayDefaultModelSelection,
  HermesGatewaySpecificModelSelection,
]);
export type HermesGatewayRequestedModelSelection = typeof HermesGatewayRequestedModelSelection.Type;

/** The concrete provider and model Hermes applied to a turn. */
export const HermesGatewayEffectiveModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
});
export type HermesGatewayEffectiveModel = typeof HermesGatewayEffectiveModel.Type;

/** One selectable model in the catalog reported by the connected Hermes process. */
export const HermesGatewayCatalogModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  providerName: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  supportsReasoning: Schema.Boolean,
});
export type HermesGatewayCatalogModel = typeof HermesGatewayCatalogModel.Type;

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

/**
 * A file riding a turn frame toward the plugin. Inline base64 on the frame
 * itself: no side-channel fetch (the plugin may be on another machine with
 * no authenticated route back), no chunking. The adapter enforces the
 * per-turn total; the schema bounds each file.
 */
export const HermesGatewayTurnAttachment = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: PositiveInt,
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HERMES_MEDIA_MAX_BASE64_CHARS),
  ),
});
export type HermesGatewayTurnAttachment = typeof HermesGatewayTurnAttachment.Type;

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
  attachments: Schema.optional(Schema.Array(HermesGatewayTurnAttachment)),
  modelSelection: Schema.optional(HermesGatewayRequestedModelSelection),
  reasoningEffort: Schema.optional(HermesGatewayReasoningEffort),
});
export type HermesGatewayTurnStart = typeof HermesGatewayTurnStart.Type;

export const HermesGatewayTurnSteer = Schema.Struct({
  type: Schema.Literal("turn.steer"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
  text: HermesGatewayTurnText,
  attachments: Schema.optional(Schema.Array(HermesGatewayTurnAttachment)),
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

/**
 * Ask a connected plugin to describe the agent it fronts — versions, model,
 * reasoning effort, and installed skills. Backs the Agent page.
 */
export const HermesGatewayDescribeRequest = Schema.Struct({
  type: Schema.Literal("describe.request"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
});
export type HermesGatewayDescribeRequest = typeof HermesGatewayDescribeRequest.Type;

/** Ask the connected Hermes process for its current selectable model catalog. */
export const HermesGatewayModelsListRequest = Schema.Struct({
  type: Schema.Literal("models.list.request"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
});
export type HermesGatewayModelsListRequest = typeof HermesGatewayModelsListRequest.Type;

/** Ask for one skill's markdown body. Fired on row expand, never eagerly. */
export const HermesGatewaySkillBodyRequest = Schema.Struct({
  type: Schema.Literal("skill.body.request"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  skillName: TrimmedNonEmptyString,
});
export type HermesGatewaySkillBodyRequest = typeof HermesGatewaySkillBodyRequest.Type;

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
  activeTurnId: Schema.optional(TurnId),
});
export type HermesGatewaySessionReady = typeof HermesGatewaySessionReady.Type;

export const HermesGatewayTurnStarted = Schema.Struct({
  type: Schema.Literal("turn.started"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  ...HermesGatewayTurnContext.fields,
  appliedModelSelection: Schema.optional(HermesGatewayEffectiveModel),
  appliedReasoningEffort: Schema.optional(HermesGatewayReasoningEffort),
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

export const HermesGatewayContentSnapshot = Schema.Struct({
  type: Schema.Literal("content.snapshot"),
  protocolVersion: HermesGatewayProtocolVersion,
  ...HermesGatewayTurnContext.fields,
  itemId: Schema.optional(HermesGatewayItemId),
  streamKind: HermesGatewayContentStreamKind,
  text: Schema.String,
  contentIndex: Schema.optional(NonNegativeInt),
});
export type HermesGatewayContentSnapshot = typeof HermesGatewayContentSnapshot.Type;

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

/**
 * One skill as the plugin reports it.
 *
 * `source` is Hermes' category, the closest thing its public skills surface
 * publishes to an install source — there is no on-disk path in that surface,
 * so T3 must not expect one. Optional fields are *omitted* by the plugin when
 * unreadable rather than sent as null.
 */
export const HermesGatewayDescribedSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  source: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
});
export type HermesGatewayDescribedSkill = typeof HermesGatewayDescribedSkill.Type;

export const HermesGatewayModelsListResponse = Schema.Struct({
  type: Schema.Literal("models.list.response"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  currentProvider: Schema.optional(TrimmedNonEmptyString),
  currentModel: Schema.optional(TrimmedNonEmptyString),
  currentReasoningEffort: Schema.optional(HermesGatewayReasoningEffort),
  reasoningEfforts: Schema.Array(HermesGatewayReasoningEffort),
  models: Schema.Array(HermesGatewayCatalogModel),
});
export type HermesGatewayModelsListResponse = typeof HermesGatewayModelsListResponse.Type;

export const HermesGatewayDescribeResponse = Schema.Struct({
  type: Schema.Literal("describe.response"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  pluginVersion: TrimmedNonEmptyString,
  hermesVersion: TrimmedNonEmptyString,
  capabilities: HermesGatewayHelloCapabilities,
  // Optional on the wire: the plugin omits what it could not read from Hermes
  // so T3 falls back to its own generic labels instead of rendering an empty
  // value as if it were reported.
  model: Schema.optional(TrimmedNonEmptyString),
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  skills: Schema.Array(HermesGatewayDescribedSkill),
  describedAt: IsoDateTime,
});
export type HermesGatewayDescribeResponse = typeof HermesGatewayDescribeResponse.Type;

export const HermesGatewaySkillBodyResponse = Schema.Struct({
  type: Schema.Literal("skill.body.response"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  skillName: TrimmedNonEmptyString,
  // Explicitly nullable, unlike the omit-on-failure fields above: the request
  // named a skill, so the caller must be able to tell "nothing to show for
  // this one" apart from a reply that never arrived.
  markdown: Schema.NullOr(Schema.String),
});
export type HermesGatewaySkillBodyResponse = typeof HermesGatewaySkillBodyResponse.Type;

export const HermesGatewayPong = Schema.Struct({
  type: Schema.Literal("pong"),
  protocolVersion: HermesGatewayProtocolVersion,
  requestId: HermesGatewayRequestId,
  sentAt: IsoDateTime,
});
export type HermesGatewayPong = typeof HermesGatewayPong.Type;

/**
 * Plugin-minted, stable across retries. T3 dedupes on it, which is what makes
 * the plugin's queue safe to flush more than once.
 */
export const HermesGatewayDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("HermesGatewayDeliveryId"),
);
export type HermesGatewayDeliveryId = typeof HermesGatewayDeliveryId.Type;

/**
 * What produced a home delivery. Drives both the rendered badge and whether
 * the delivery raises its hand: everything except `lifecycle` un-settles the
 * thread and pushes; gateway online/shutdown notices land quietly.
 *
 * Classification is best-effort on the plugin side — Hermes' `adapter.send()`
 * contract carries no structured provenance marker on every path — so a
 * misclassification costs a wrong badge, never a lost delivery.
 */
export const HermesGatewayHomeDeliveryKind = Schema.Literals([
  "cron",
  "message",
  "lifecycle",
  "handoff",
  "other",
]);
export type HermesGatewayHomeDeliveryKind = typeof HermesGatewayHomeDeliveryKind.Type;

/**
 * Hermes-initiated delivery into the instance's home thread.
 *
 * Deliberately not a turn: there is no provider session, no turn id, and no
 * request the delivery answers. A delivery may arrive while the home thread
 * has a live user turn and must not disturb it.
 */
export const HermesGatewayHomeDeliver = Schema.Struct({
  type: Schema.Literal("home.deliver"),
  protocolVersion: HermesGatewayProtocolVersion,
  deliveryId: HermesGatewayDeliveryId,
  threadId: ThreadId,
  kind: HermesGatewayHomeDeliveryKind,
  /** Human source label rendered as the badge — "Cron: daily-digest". */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120_000)),
  /**
   * When Hermes produced the content, not when it reached T3. These diverge
   * whenever a queued delivery flushes after a reconnect.
   */
  createdAt: IsoDateTime,
});
export type HermesGatewayHomeDeliver = typeof HermesGatewayHomeDeliver.Type;

/**
 * Sent only after the delivery is durably written. The plugin purges its
 * queued copy on this frame and nothing else, so acking early loses messages.
 */
export const HermesGatewayHomeDeliverAck = Schema.Struct({
  type: Schema.Literal("home.deliver.ack"),
  protocolVersion: HermesGatewayProtocolVersion,
  deliveryId: HermesGatewayDeliveryId,
});
export type HermesGatewayHomeDeliverAck = typeof HermesGatewayHomeDeliverAck.Type;

/**
 * Hermes-initiated media (an image, video, PDF, or arbitrary file) delivered
 * as its own message rather than folded into a streaming turn.
 *
 * Shaped like `home.deliver` on purpose: self-contained, idempotent on
 * `deliveryId`, acked only after the bytes are durably written, so the
 * plugin's queued copy survives every disconnect between send and ack.
 *
 * Scope is carried by which ids are present:
 * - `turnId` set — media produced during a live turn; lands in that thread
 *   sequenced next to the turn's text.
 * - `turnId` absent — proactive media (a cron job's chart, an artifact from
 *   an agent-initiated task). `threadId` is advisory the same way it is for
 *   `home.deliver`: the server re-resolves the instance's home thread and
 *   refuses to write anywhere else, so a confused plugin cannot spray files
 *   into arbitrary threads. `kind`/`label` provenance renders the same
 *   notification header a text delivery gets.
 */
export const HermesGatewayMediaDeliver = Schema.Struct({
  type: Schema.Literal("media.deliver"),
  protocolVersion: HermesGatewayProtocolVersion,
  deliveryId: HermesGatewayDeliveryId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  kind: HermesGatewayHomeDeliveryKind,
  /** Human source label rendered as the badge — "Cron: daily-digest". */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: PositiveInt,
  /** Optional caption rendered under the media in the same message row. */
  caption: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HERMES_MEDIA_MAX_BASE64_CHARS),
  ),
  /** When Hermes produced the media, not when it reached T3. */
  createdAt: IsoDateTime,
});
export type HermesGatewayMediaDeliver = typeof HermesGatewayMediaDeliver.Type;

/**
 * Sent only after the media's bytes and its message row are durably written —
 * the same pessimistic-ack contract as `home.deliver.ack`.
 */
export const HermesGatewayMediaDeliverAck = Schema.Struct({
  type: Schema.Literal("media.deliver.ack"),
  protocolVersion: HermesGatewayProtocolVersion,
  deliveryId: HermesGatewayDeliveryId,
});
export type HermesGatewayMediaDeliverAck = typeof HermesGatewayMediaDeliverAck.Type;

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
  HermesGatewayDescribeRequest,
  HermesGatewayModelsListRequest,
  HermesGatewaySkillBodyRequest,
  HermesGatewayPing,
  HermesGatewayHomeDeliverAck,
  HermesGatewayMediaDeliverAck,
]);
export type HermesGatewayT3ToPluginMessage = typeof HermesGatewayT3ToPluginMessage.Type;

export const HermesGatewayPluginToT3Message = Schema.Union([
  HermesGatewayConnectionHello,
  HermesGatewayConnectionStatus,
  HermesGatewaySessionReady,
  HermesGatewayTurnStarted,
  HermesGatewayContentDelta,
  HermesGatewayContentSnapshot,
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
  HermesGatewayDescribeResponse,
  HermesGatewayModelsListResponse,
  HermesGatewaySkillBodyResponse,
  HermesGatewayPong,
  HermesGatewayProtocolError,
  HermesGatewayHomeDeliver,
  HermesGatewayMediaDeliver,
]);
export type HermesGatewayPluginToT3Message = typeof HermesGatewayPluginToT3Message.Type;

export const HermesGatewayWireMessage = Schema.Union([
  HermesGatewayT3ToPluginMessage,
  HermesGatewayPluginToT3Message,
]);
export type HermesGatewayWireMessage = typeof HermesGatewayWireMessage.Type;
