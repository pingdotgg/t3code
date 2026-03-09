import { Schema, Struct } from "effect";
import {
  HarnessConnectorId,
  HarnessProfileId,
  HarnessSessionId,
  NonNegativeInt,
  RuntimeRequestId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  HarnessConnectionMode,
  HarnessNativeFrame,
  HarnessPermissionDecision,
  HarnessProfile,
  HarnessQuestion,
  HarnessSession,
  HarnessSnapshot,
} from "./harness";
import { HarnessEvent } from "./harnessEvents";

export const HARNESS_WS_METHODS = {
  listProfiles: "harness.listProfiles",
  upsertProfile: "harness.upsertProfile",
  deleteProfile: "harness.deleteProfile",
  listSessions: "harness.listSessions",
  getSnapshot: "harness.getSnapshot",
  createSession: "harness.createSession",
  attachSession: "harness.attachSession",
  resumeSession: "harness.resumeSession",
  sendTurn: "harness.sendTurn",
  cancelTurn: "harness.cancelTurn",
  resolvePermission: "harness.resolvePermission",
  resolveElicitation: "harness.resolveElicitation",
  updateSessionConfig: "harness.updateSessionConfig",
  replayEvents: "harness.replayEvents",
  getNativeFrames: "harness.getNativeFrames",
} as const;

export const CONNECTOR_WS_METHODS = {
  register: "connector.register",
  bindProfile: "connector.bindProfile",
  acceptSession: "connector.acceptSession",
  publishEvent: "connector.publishEvent",
  publishRawFrame: "connector.publishRawFrame",
  heartbeat: "connector.heartbeat",
  completeCommand: "connector.completeCommand",
} as const;

export const HARNESS_WS_CHANNELS = {
  event: "harness.event",
  snapshotUpdated: "harness.snapshot.updated",
  connectorUpdated: "harness.connector.updated",
} as const;

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(Struct.assign({ _tag: Schema.tag(tag) }), {
    unsafePreserveChecks: true,
  });

export const HarnessSendTurnInput = Schema.Struct({
  sessionId: HarnessSessionId,
  input: Schema.optional(Schema.String),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
});
export type HarnessSendTurnInput = typeof HarnessSendTurnInput.Type;

export const HarnessUpdateSessionConfigInput = Schema.Struct({
  sessionId: HarnessSessionId,
  title: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
});
export type HarnessUpdateSessionConfigInput = typeof HarnessUpdateSessionConfigInput.Type;

export const HarnessResolvePermissionInput = Schema.Struct({
  sessionId: HarnessSessionId,
  requestId: RuntimeRequestId,
  decision: HarnessPermissionDecision,
});
export type HarnessResolvePermissionInput = typeof HarnessResolvePermissionInput.Type;

export const HarnessResolveElicitationInput = Schema.Struct({
  sessionId: HarnessSessionId,
  requestId: RuntimeRequestId,
  answers: Schema.Array(Schema.Array(TrimmedNonEmptyString)),
});
export type HarnessResolveElicitationInput = typeof HarnessResolveElicitationInput.Type;

export const HarnessClientRequestBody = Schema.Union([
  tagRequestBody(HARNESS_WS_METHODS.listProfiles, Schema.Struct({})),
  tagRequestBody(HARNESS_WS_METHODS.upsertProfile, Schema.Struct({ profile: HarnessProfile })),
  tagRequestBody(HARNESS_WS_METHODS.deleteProfile, Schema.Struct({ profileId: HarnessProfileId })),
  tagRequestBody(HARNESS_WS_METHODS.listSessions, Schema.Struct({})),
  tagRequestBody(HARNESS_WS_METHODS.getSnapshot, Schema.Struct({})),
  tagRequestBody(
    HARNESS_WS_METHODS.createSession,
    Schema.Struct({
      profileId: HarnessProfileId,
      title: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  tagRequestBody(
    HARNESS_WS_METHODS.attachSession,
    Schema.Struct({
      profileId: HarnessProfileId,
      connectionMode: HarnessConnectionMode,
    }),
  ),
  tagRequestBody(
    HARNESS_WS_METHODS.resumeSession,
    Schema.Struct({
      sessionId: HarnessSessionId,
    }),
  ),
  tagRequestBody(HARNESS_WS_METHODS.sendTurn, HarnessSendTurnInput),
  tagRequestBody(
    HARNESS_WS_METHODS.cancelTurn,
    Schema.Struct({
      sessionId: HarnessSessionId,
    }),
  ),
  tagRequestBody(HARNESS_WS_METHODS.resolvePermission, HarnessResolvePermissionInput),
  tagRequestBody(HARNESS_WS_METHODS.resolveElicitation, HarnessResolveElicitationInput),
  tagRequestBody(HARNESS_WS_METHODS.updateSessionConfig, HarnessUpdateSessionConfigInput),
  tagRequestBody(
    HARNESS_WS_METHODS.replayEvents,
    Schema.Struct({
      sessionId: HarnessSessionId,
      fromSequence: Schema.optional(NonNegativeInt),
    }),
  ),
  tagRequestBody(
    HARNESS_WS_METHODS.getNativeFrames,
    Schema.Struct({
      sessionId: HarnessSessionId,
    }),
  ),
]);

export const HarnessConnectorRequestBody = Schema.Union([
  tagRequestBody(
    CONNECTOR_WS_METHODS.register,
    Schema.Struct({
      connectorId: HarnessConnectorId,
      description: Schema.optional(TrimmedNonEmptyString),
      version: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.bindProfile,
    Schema.Struct({
      connectorId: HarnessConnectorId,
      profileId: HarnessProfileId,
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.acceptSession,
    Schema.Struct({
      connectorId: HarnessConnectorId,
      sessionId: HarnessSessionId,
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.publishEvent,
    Schema.Struct({
      event: HarnessEvent,
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.publishRawFrame,
    Schema.Struct({
      frame: HarnessNativeFrame,
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.heartbeat,
    Schema.Struct({
      connectorId: HarnessConnectorId,
    }),
  ),
  tagRequestBody(
    CONNECTOR_WS_METHODS.completeCommand,
    Schema.Struct({
      connectorId: HarnessConnectorId,
      sessionId: HarnessSessionId,
      ok: Schema.Boolean,
      detail: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
]);

export const HarnessWebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: HarnessClientRequestBody,
});
export type HarnessWebSocketRequest = typeof HarnessWebSocketRequest.Type;

export const HarnessConnectorWebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: HarnessConnectorRequestBody,
});
export type HarnessConnectorWebSocketRequest = typeof HarnessConnectorWebSocketRequest.Type;

export const HarnessWebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(
    Schema.Union([
      Schema.Array(HarnessProfile),
      Schema.Array(HarnessSession),
      HarnessSnapshot,
      Schema.Array(HarnessEvent),
      Schema.Array(HarnessNativeFrame),
      Schema.Boolean,
      HarnessSession,
      HarnessProfile,
    ]),
  ),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type HarnessWebSocketResponse = typeof HarnessWebSocketResponse.Type;

export const HarnessWsPush = Schema.Struct({
  type: Schema.Literal("push"),
  channel: TrimmedNonEmptyString,
  data: Schema.Union([HarnessEvent, HarnessSnapshot, HarnessSession, HarnessQuestion]),
});
export type HarnessWsPush = typeof HarnessWsPush.Type;
