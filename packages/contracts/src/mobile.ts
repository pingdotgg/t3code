import { Effect, Option, Schema, SchemaIssue } from "effect";

import {
  AuthBootstrapInput,
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "./auth.ts";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationReplayEventsInput,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";

export const MOBILE_PROTOCOL_VERSION = "mobile.v1" as const;
export const MOBILE_HTTP_PREFIX = "/mobile/v1" as const;
export const MOBILE_WS_PATH = "/mobile/v1/ws" as const;

export const MobileProtocolVersion = Schema.Literal(MOBILE_PROTOCOL_VERSION);
export type MobileProtocolVersion = typeof MobileProtocolVersion.Type;

export const MobileClientCapability = Schema.Literals([
  "auth.bearer-bootstrap",
  "auth.ws-token",
  "orchestration.shell",
  "orchestration.thread-detail",
  "orchestration.replay-envelope",
  "orchestration.command-receipts",
  "diff.turn",
  "diff.full-thread",
]);
export type MobileClientCapability = typeof MobileClientCapability.Type;

export const MobileServerCapability = MobileClientCapability;
export type MobileServerCapability = typeof MobileServerCapability.Type;

export const MOBILE_V1_SERVER_CAPABILITIES = [
  "auth.bearer-bootstrap",
  "auth.ws-token",
  "orchestration.shell",
  "orchestration.thread-detail",
  "orchestration.replay-envelope",
  "orchestration.command-receipts",
  "diff.turn",
  "diff.full-thread",
] as const satisfies ReadonlyArray<MobileServerCapability>;

const MobileProtocolEnvelopeFields = {
  protocolVersion: MobileProtocolVersion,
  serverCapabilities: Schema.Array(MobileServerCapability),
} as const;

export const MobileProtocolEnvelope = Schema.Struct(MobileProtocolEnvelopeFields);
export type MobileProtocolEnvelope = typeof MobileProtocolEnvelope.Type;

export const MobileEndpointDescriptor = Schema.Struct({
  descriptor: TrimmedNonEmptyString,
  authBearerBootstrap: TrimmedNonEmptyString,
  authSession: TrimmedNonEmptyString,
  authWebSocketToken: TrimmedNonEmptyString,
  websocket: TrimmedNonEmptyString,
});
export type MobileEndpointDescriptor = typeof MobileEndpointDescriptor.Type;

export const MobileDescriptorResult = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  minSupportedProtocolVersion: MobileProtocolVersion,
  endpoints: MobileEndpointDescriptor,
  environment: ExecutionEnvironmentDescriptor,
});
export type MobileDescriptorResult = typeof MobileDescriptorResult.Type;

export const MobileAuthBearerBootstrapInput = AuthBootstrapInput;
export type MobileAuthBearerBootstrapInput = typeof MobileAuthBearerBootstrapInput.Type;

export const MobileAuthBearerBootstrapResult = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  result: AuthBearerBootstrapResult,
});
export type MobileAuthBearerBootstrapResult = typeof MobileAuthBearerBootstrapResult.Type;

export const MobileAuthSessionResult = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  result: AuthSessionState,
});
export type MobileAuthSessionResult = typeof MobileAuthSessionResult.Type;

export const MobileAuthWebSocketTokenResult = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  result: AuthWebSocketTokenResult,
});
export type MobileAuthWebSocketTokenResult = typeof MobileAuthWebSocketTokenResult.Type;

export const MobileHelloMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("hello"),
  protocolVersion: MobileProtocolVersion,
  capabilities: Schema.Array(MobileClientCapability),
});
export type MobileHelloMessage = typeof MobileHelloMessage.Type;

export const MobileSubscribeShellRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.subscribeShell"),
  payload: Schema.Struct({}),
});

export const MobileSubscribeThreadRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.subscribeThread"),
  payload: Schema.Struct({
    threadId: ThreadId,
  }),
});

export const MobileReplayEventsRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.replayEvents"),
  payload: OrchestrationReplayEventsInput,
});

export const MobileClientOrchestrationCommand = ClientOrchestrationCommand.check(
  Schema.makeFilter(
    (command) =>
      (command.type === "thread.turn.start" && command.bootstrap === undefined) ||
      command.type === "thread.turn.interrupt" ||
      command.type === "thread.approval.respond" ||
      command.type === "thread.user-input.respond" ||
      command.type === "thread.checkpoint.revert" ||
      command.type === "thread.session.stop" ||
      new SchemaIssue.InvalidValue(Option.some(command.type), {
        message:
          "mobile.v1 only supports read+chat commands: turn start without bootstrap, interrupt, approval response, user input response, checkpoint revert, and session stop",
      }),
    { identifier: "MobileClientOrchestrationCommand" },
  ),
);
export type MobileClientOrchestrationCommand = Extract<
  ClientOrchestrationCommand,
  {
    readonly type:
      | "thread.turn.start"
      | "thread.turn.interrupt"
      | "thread.approval.respond"
      | "thread.user-input.respond"
      | "thread.checkpoint.revert"
      | "thread.session.stop";
  }
>;

export const MobileDispatchCommandRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.dispatchCommand"),
  payload: MobileClientOrchestrationCommand,
});

export const MobileGetTurnDiffRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.getTurnDiff"),
  payload: OrchestrationGetTurnDiffInput,
});

export const MobileGetFullThreadDiffRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("request"),
  protocolVersion: MobileProtocolVersion,
  method: Schema.Literal("orchestration.getFullThreadDiff"),
  payload: OrchestrationGetFullThreadDiffInput,
});

export const MobileRequestMessage = Schema.Union([
  MobileSubscribeShellRequest,
  MobileSubscribeThreadRequest,
  MobileReplayEventsRequest,
  MobileDispatchCommandRequest,
  MobileGetTurnDiffRequest,
  MobileGetFullThreadDiffRequest,
]);
export type MobileRequestMessage = typeof MobileRequestMessage.Type;

export const MobileClientMessage = Schema.Union([MobileHelloMessage, MobileRequestMessage]);
export type MobileClientMessage = typeof MobileClientMessage.Type;

export const MobileHelloResponse = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  id: TrimmedNonEmptyString,
  type: Schema.Literal("hello"),
});
export type MobileHelloResponse = typeof MobileHelloResponse.Type;

export const MobileErrorCode = Schema.Literals([
  "unsupported-protocol-version",
  "invalid-message",
  "unauthorized",
  "not-found",
  "replay-gap",
  "command-rejected",
  "internal-error",
]);
export type MobileErrorCode = typeof MobileErrorCode.Type;

export const MobileErrorPayload = Schema.Struct({
  code: MobileErrorCode,
  message: TrimmedNonEmptyString,
});
export type MobileErrorPayload = typeof MobileErrorPayload.Type;

export const MobileErrorMessage = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  id: Schema.NullOr(TrimmedNonEmptyString),
  type: Schema.Literal("error"),
  error: MobileErrorPayload,
});
export type MobileErrorMessage = typeof MobileErrorMessage.Type;

export const MobileReplayStatus = Schema.Literals([
  "complete",
  "partial-unavailable",
  "cursor-too-old",
  "incompatible-schema",
]);
export type MobileReplayStatus = typeof MobileReplayStatus.Type;

export const MobileResnapshotTarget = Schema.Literals(["shell", "active-threads", "all"]);
export type MobileResnapshotTarget = typeof MobileResnapshotTarget.Type;

export const MobileReplayEnvelope = Schema.Struct({
  status: MobileReplayStatus,
  fromSequenceExclusive: NonNegativeInt,
  returnedFromSequenceExclusive: NonNegativeInt,
  returnedToSequenceInclusive: NonNegativeInt,
  serverHighWaterSequence: NonNegativeInt,
  events: Schema.Array(OrchestrationEvent),
  resnapshot: Schema.Array(MobileResnapshotTarget).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  error: Schema.optional(MobileErrorPayload),
});
export type MobileReplayEnvelope = typeof MobileReplayEnvelope.Type;

export const MobileCommandReceiptStatus = Schema.Literals(["accepted", "duplicate", "rejected"]);
export type MobileCommandReceiptStatus = typeof MobileCommandReceiptStatus.Type;

export const MobileCommandReceipt = Schema.Struct({
  status: MobileCommandReceiptStatus,
  commandId: CommandId,
  payloadHash: TrimmedNonEmptyString,
  acceptedAt: IsoDateTime,
  sequence: Schema.optional(NonNegativeInt),
  error: Schema.optional(MobileErrorPayload),
});
export type MobileCommandReceipt = typeof MobileCommandReceipt.Type;

export const MobileResponsePayload = Schema.Union([
  MobileReplayEnvelope,
  MobileCommandReceipt,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetFullThreadDiffResult,
]);
export type MobileResponsePayload = typeof MobileResponsePayload.Type;

export const MobileResponseMessage = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  id: TrimmedNonEmptyString,
  type: Schema.Literal("response"),
  payload: MobileResponsePayload,
});
export type MobileResponseMessage = typeof MobileResponseMessage.Type;

export const MobileStreamPayload = Schema.Union([
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
]);
export type MobileStreamPayload = typeof MobileStreamPayload.Type;

export const MobileStreamMessage = Schema.Struct({
  ...MobileProtocolEnvelopeFields,
  id: TrimmedNonEmptyString,
  type: Schema.Literal("stream"),
  payload: MobileStreamPayload,
});
export type MobileStreamMessage = typeof MobileStreamMessage.Type;

export const MobileServerMessage = Schema.Union([
  MobileHelloResponse,
  MobileErrorMessage,
  MobileResponseMessage,
  MobileStreamMessage,
]);
export type MobileServerMessage = typeof MobileServerMessage.Type;
