import { Schema } from "effect";

const IsoDateTimeSchema = Schema.String;
const IdSchema = Schema.String;

export const ProviderRuntimeProviderSchema = Schema.Literals(["codex", "claudeCode"]);
export type ProviderRuntimeProvider = Schema.Schema.Type<typeof ProviderRuntimeProviderSchema>;

export const ProviderRuntimeApprovalKindSchema = Schema.Literals(["command", "file-change"]);
export type ProviderRuntimeApprovalKind = Schema.Schema.Type<
  typeof ProviderRuntimeApprovalKindSchema
>;

export const ProviderRuntimeToolKindSchema = Schema.Literals(["command", "file-change", "other"]);
export type ProviderRuntimeToolKind = Schema.Schema.Type<typeof ProviderRuntimeToolKindSchema>;

export const ProviderRuntimeTurnStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ProviderRuntimeTurnStatus = Schema.Schema.Type<typeof ProviderRuntimeTurnStatusSchema>;

export const ProviderRuntimeSessionStartedEventSchema = Schema.Struct({
  type: Schema.Literal("session.started"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export const ProviderRuntimeSessionExitedEventSchema = Schema.Struct({
  type: Schema.Literal("session.exited"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export const ProviderRuntimeThreadStartedEventSchema = Schema.Struct({
  type: Schema.Literal("thread.started"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: IdSchema,
});

export const ProviderRuntimeTurnStartedEventSchema = Schema.Struct({
  type: Schema.Literal("turn.started"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: IdSchema,
});

export const ProviderRuntimeTurnCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  status: Schema.optional(ProviderRuntimeTurnStatusSchema),
  errorMessage: Schema.optional(Schema.String),
});

export const ProviderRuntimeMessageDeltaEventSchema = Schema.Struct({
  type: Schema.Literal("message.delta"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  delta: Schema.String,
});

export const ProviderRuntimeToolStartedEventSchema = Schema.Struct({
  type: Schema.Literal("tool.started"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  toolKind: ProviderRuntimeToolKindSchema,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
});

export const ProviderRuntimeToolCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("tool.completed"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  toolKind: ProviderRuntimeToolKindSchema,
  title: Schema.String,
  detail: Schema.optional(Schema.String),
});

export const ProviderRuntimeApprovalRequestedEventSchema = Schema.Struct({
  type: Schema.Literal("approval.requested"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  requestId: IdSchema,
  requestKind: ProviderRuntimeApprovalKindSchema,
  detail: Schema.optional(Schema.String),
});

export const ProviderRuntimeApprovalResolvedEventSchema = Schema.Struct({
  type: Schema.Literal("approval.resolved"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  requestId: IdSchema,
  requestKind: Schema.optional(ProviderRuntimeApprovalKindSchema),
  decision: Schema.optional(Schema.String),
});

export const ProviderRuntimeCheckpointCapturedEventSchema = Schema.Struct({
  type: Schema.Literal("checkpoint.captured"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: IdSchema,
  turnId: Schema.optional(Schema.String),
  turnCount: Schema.Number,
  status: Schema.optional(ProviderRuntimeTurnStatusSchema),
});

export const ProviderRuntimeErrorEventSchema = Schema.Struct({
  type: Schema.Literal("runtime.error"),
  eventId: IdSchema,
  provider: ProviderRuntimeProviderSchema,
  sessionId: IdSchema,
  createdAt: IsoDateTimeSchema,
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  message: Schema.String,
});

export const ProviderRuntimeEventSchema = Schema.Union([
  ProviderRuntimeSessionStartedEventSchema,
  ProviderRuntimeSessionExitedEventSchema,
  ProviderRuntimeThreadStartedEventSchema,
  ProviderRuntimeTurnStartedEventSchema,
  ProviderRuntimeTurnCompletedEventSchema,
  ProviderRuntimeMessageDeltaEventSchema,
  ProviderRuntimeToolStartedEventSchema,
  ProviderRuntimeToolCompletedEventSchema,
  ProviderRuntimeApprovalRequestedEventSchema,
  ProviderRuntimeApprovalResolvedEventSchema,
  ProviderRuntimeCheckpointCapturedEventSchema,
  ProviderRuntimeErrorEventSchema,
]);

export type ProviderRuntimeSessionStartedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeSessionStartedEventSchema
>;
export type ProviderRuntimeSessionExitedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeSessionExitedEventSchema
>;
export type ProviderRuntimeThreadStartedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeThreadStartedEventSchema
>;
export type ProviderRuntimeTurnStartedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeTurnStartedEventSchema
>;
export type ProviderRuntimeTurnCompletedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeTurnCompletedEventSchema
>;
export type ProviderRuntimeMessageDeltaEvent = Schema.Schema.Type<
  typeof ProviderRuntimeMessageDeltaEventSchema
>;
export type ProviderRuntimeToolStartedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeToolStartedEventSchema
>;
export type ProviderRuntimeToolCompletedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeToolCompletedEventSchema
>;
export type ProviderRuntimeApprovalRequestedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeApprovalRequestedEventSchema
>;
export type ProviderRuntimeApprovalResolvedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeApprovalResolvedEventSchema
>;
export type ProviderRuntimeCheckpointCapturedEvent = Schema.Schema.Type<
  typeof ProviderRuntimeCheckpointCapturedEventSchema
>;
export type ProviderRuntimeErrorEvent = Schema.Schema.Type<typeof ProviderRuntimeErrorEventSchema>;
export type ProviderRuntimeEvent = Schema.Schema.Type<typeof ProviderRuntimeEventSchema>;
