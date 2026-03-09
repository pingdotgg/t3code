import { Schema } from "effect";
import {
  EventId,
  HarnessConnectorId,
  HarnessSessionId,
  IsoDateTime,
  NonNegativeInt,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import {
  HarnessBinding,
  HarnessCapabilitySet,
  HarnessConnectionMode,
  HarnessKind,
  HarnessPermissionDecision,
  HarnessPermissionKind,
  HarnessQuestion,
  HarnessTurnState,
} from "./harness";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const HarnessEventBase = Schema.Struct({
  eventId: EventId,
  sessionId: HarnessSessionId,
  createdAt: IsoDateTime,
  sequence: NonNegativeInt,
  harness: HarnessKind,
  adapterKey: TrimmedNonEmptyString,
  connectionMode: HarnessConnectionMode,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  nativeRefs: Schema.optional(UnknownRecord),
});
export type HarnessEventBase = typeof HarnessEventBase.Type;

const SessionCreatedPayload = Schema.Struct({
  profileId: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
  state: Schema.optional(
    Schema.Literals(["idle", "starting", "ready", "running", "waiting", "stopped", "error"]),
  ),
  capabilities: Schema.optional(HarnessCapabilitySet),
  metadata: Schema.optional(UnknownRecord),
});

const SessionBoundPayload = Schema.Struct({
  binding: HarnessBinding,
});

const SessionStateChangedPayload = Schema.Struct({
  state: Schema.Literals(["idle", "starting", "ready", "running", "waiting", "stopped", "error"]),
  reason: Schema.optional(TrimmedNonEmptyString),
  recoverable: Schema.optional(Schema.Boolean),
});

const SessionConfigChangedPayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
  metadata: Schema.optional(UnknownRecord),
});

const SessionCapabilitiesChangedPayload = Schema.Struct({
  capabilities: HarnessCapabilitySet,
});

const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyString),
  recoverable: Schema.optional(Schema.Boolean),
});

const TurnStartedPayload = Schema.Struct({
  input: Schema.optional(Schema.String),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(TrimmedNonEmptyString),
});

const TurnStateChangedPayload = Schema.Struct({
  state: HarnessTurnState,
  detail: Schema.optional(TrimmedNonEmptyString),
});

const TurnCompletedPayload = Schema.Struct({
  stopReason: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(Schema.Unknown),
});

const TurnFailedPayload = Schema.Struct({
  message: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.Unknown),
});

const TurnCancelledPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyString),
});

const MessageStartedPayload = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system"]),
  stream: Schema.optional(Schema.Literals(["assistant", "reasoning", "plan"])),
});

const MessageDeltaPayload = Schema.Struct({
  role: Schema.optional(Schema.Literals(["assistant", "system"])),
  stream: Schema.optional(Schema.Literals(["assistant", "reasoning", "plan"])),
  delta: Schema.String,
});

const MessageCompletedPayload = Schema.Struct({
  role: Schema.optional(Schema.Literals(["assistant", "system"])),
  text: Schema.optional(Schema.String),
});

const ReasoningDeltaPayload = Schema.Struct({
  delta: Schema.String,
});

const ReasoningSummaryPayload = Schema.Struct({
  text: TrimmedNonEmptyString,
});

const PlanStep = Schema.Struct({
  step: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "in-progress", "completed"]),
});

const PlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(TrimmedNonEmptyString),
  steps: Schema.Array(PlanStep),
});

const PlanDeltaPayload = Schema.Struct({
  delta: Schema.String,
});

const PlanCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyString,
});

const ItemLifecyclePayload = Schema.Struct({
  itemType: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(TrimmedNonEmptyString),
  data: Schema.optional(Schema.Unknown),
});

const PermissionRequestedPayload = Schema.Struct({
  requestId: RuntimeRequestId,
  kind: HarnessPermissionKind,
  title: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Unknown),
});

const PermissionResolvedPayload = Schema.Struct({
  requestId: RuntimeRequestId,
  decision: HarnessPermissionDecision,
  detail: Schema.optional(TrimmedNonEmptyString),
});

const ElicitationRequestedPayload = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(HarnessQuestion),
});

const ElicitationResolvedPayload = Schema.Struct({
  requestId: RuntimeRequestId,
  answers: Schema.Array(Schema.Array(TrimmedNonEmptyString)),
});

const ArtifactPersistedPayload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      path: TrimmedNonEmptyString,
      kind: TrimmedNonEmptyString,
    }),
  ),
});

const ConnectorConnectedPayload = Schema.Struct({
  connectorId: HarnessConnectorId,
  description: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  metadata: Schema.optional(UnknownRecord),
});

const ConnectorHealthChangedPayload = Schema.Struct({
  connectorId: HarnessConnectorId,
  health: Schema.Literals(["connected", "degraded", "disconnected"]),
  detail: Schema.optional(TrimmedNonEmptyString),
});

const TransportMessagePayload = Schema.Struct({
  message: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.Unknown),
});

const NativeFramePayload = Schema.Struct({
  source: TrimmedNonEmptyString,
  payload: Schema.Unknown,
});

function defineEvent<Type extends string, Payload extends Schema.Top>(
  type: Type,
  payload: Payload,
) {
  return Schema.Struct({
    ...HarnessEventBase.fields,
    type: Schema.Literal(type),
    payload,
  });
}

export const HarnessEvent = Schema.Union([
  defineEvent("session.created", SessionCreatedPayload),
  defineEvent("session.bound", SessionBoundPayload),
  defineEvent("session.state.changed", SessionStateChangedPayload),
  defineEvent("session.config.changed", SessionConfigChangedPayload),
  defineEvent("session.capabilities.changed", SessionCapabilitiesChangedPayload),
  defineEvent("session.exited", SessionExitedPayload),
  defineEvent("turn.started", TurnStartedPayload),
  defineEvent("turn.state.changed", TurnStateChangedPayload),
  defineEvent("turn.completed", TurnCompletedPayload),
  defineEvent("turn.failed", TurnFailedPayload),
  defineEvent("turn.cancelled", TurnCancelledPayload),
  defineEvent("message.started", MessageStartedPayload),
  defineEvent("message.delta", MessageDeltaPayload),
  defineEvent("message.completed", MessageCompletedPayload),
  defineEvent("reasoning.delta", ReasoningDeltaPayload),
  defineEvent("reasoning.summary", ReasoningSummaryPayload),
  defineEvent("plan.updated", PlanUpdatedPayload),
  defineEvent("plan.delta", PlanDeltaPayload),
  defineEvent("plan.completed", PlanCompletedPayload),
  defineEvent("item.started", ItemLifecyclePayload),
  defineEvent("item.updated", ItemLifecyclePayload),
  defineEvent("item.completed", ItemLifecyclePayload),
  defineEvent("permission.requested", PermissionRequestedPayload),
  defineEvent("permission.resolved", PermissionResolvedPayload),
  defineEvent("elicitation.requested", ElicitationRequestedPayload),
  defineEvent("elicitation.resolved", ElicitationResolvedPayload),
  defineEvent("artifact.persisted", ArtifactPersistedPayload),
  defineEvent("connector.connected", ConnectorConnectedPayload),
  defineEvent("connector.disconnected", ConnectorConnectedPayload),
  defineEvent("connector.health.changed", ConnectorHealthChangedPayload),
  defineEvent("transport.warning", TransportMessagePayload),
  defineEvent("transport.error", TransportMessagePayload),
  defineEvent("native.frame", NativeFramePayload),
]);
export type HarnessEvent = typeof HarnessEvent.Type;
