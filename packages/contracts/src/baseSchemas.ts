import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const RunId = makeEntityId("RunId");
export type RunId = typeof RunId.Type;
export const RunAttemptId = makeEntityId("RunAttemptId");
export type RunAttemptId = typeof RunAttemptId.Type;
export const NodeId = makeEntityId("NodeId");
export type NodeId = typeof NodeId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const ProviderSessionId = makeEntityId("ProviderSessionId");
export type ProviderSessionId = typeof ProviderSessionId.Type;
export const ProviderThreadId = makeEntityId("ProviderThreadId");
export type ProviderThreadId = typeof ProviderThreadId.Type;
export const ProviderTurnId = makeEntityId("ProviderTurnId");
export type ProviderTurnId = typeof ProviderTurnId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const TurnItemId = makeEntityId("TurnItemId");
export type TurnItemId = typeof TurnItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ScheduledTaskId = makeEntityId("ScheduledTaskId");
export type ScheduledTaskId = typeof ScheduledTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
export const CheckpointId = makeEntityId("CheckpointId");
export type CheckpointId = typeof CheckpointId.Type;
export const CheckpointScopeId = makeEntityId("CheckpointScopeId");
export type CheckpointScopeId = typeof CheckpointScopeId.Type;
export const ContextHandoffId = makeEntityId("ContextHandoffId");
export type ContextHandoffId = typeof ContextHandoffId.Type;
export const ContextTransferId = makeEntityId("ContextTransferId");
export type ContextTransferId = typeof ContextTransferId.Type;
export const RawEventId = makeEntityId("RawEventId");
export type RawEventId = typeof RawEventId.Type;
export const PlanId = makeEntityId("PlanId");
export type PlanId = typeof PlanId.Type;
