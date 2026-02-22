import { Schema } from "effect";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  replayEvents: "orchestration.replayEvents",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  readModel: "orchestration.readModel",
  domainEvent: "orchestration.domainEvent",
} as const;

const IsoDateTimeSchema = Schema.String;
const IdSchema = Schema.String;

export const OrchestrationMessageSchema = Schema.Struct({
  id: IdSchema,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTimeSchema,
  streaming: Schema.Boolean,
});

export type OrchestrationMessage = Schema.Schema.Type<typeof OrchestrationMessageSchema>;

export const OrchestrationSessionSchema = Schema.Struct({
  sessionId: IdSchema,
  status: Schema.Literals(["connecting", "ready", "running", "error", "closed"]),
  provider: Schema.Literals(["codex", "claudeCode"]),
  threadId: IdSchema,
  activeTurnId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastError: Schema.NullOr(Schema.String),
});

export type OrchestrationSession = Schema.Schema.Type<typeof OrchestrationSessionSchema>;

export const OrchestrationTurnDiffFileSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.optional(Schema.String),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
});

export type OrchestrationTurnDiffFile = Schema.Schema.Type<typeof OrchestrationTurnDiffFileSchema>;

export const OrchestrationTurnDiffSummarySchema = Schema.Struct({
  turnId: IdSchema,
  completedAt: IsoDateTimeSchema,
  status: Schema.optional(Schema.String),
  files: Schema.Array(OrchestrationTurnDiffFileSchema),
  assistantMessageId: Schema.optional(Schema.String),
  checkpointTurnCount: Schema.optional(Schema.Number),
});

export type OrchestrationTurnDiffSummary = Schema.Schema.Type<
  typeof OrchestrationTurnDiffSummarySchema
>;

export const OrchestrationThreadSchema = Schema.Struct({
  id: IdSchema,
  projectId: IdSchema,
  title: Schema.String,
  model: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  latestTurnId: Schema.NullOr(Schema.String),
  latestTurnStartedAt: Schema.NullOr(Schema.String),
  latestTurnCompletedAt: Schema.NullOr(Schema.String),
  latestTurnDurationMs: Schema.NullOr(Schema.Number),
  messages: Schema.Array(OrchestrationMessageSchema),
  session: Schema.NullOr(OrchestrationSessionSchema),
  turnDiffSummaries: Schema.Array(OrchestrationTurnDiffSummarySchema),
  error: Schema.NullOr(Schema.String),
});

export type OrchestrationThread = Schema.Schema.Type<typeof OrchestrationThreadSchema>;

export const OrchestrationGitReadModelSchema = Schema.Struct({
  projectId: IdSchema,
  branch: Schema.NullOr(Schema.String),
  hasWorkingTreeChanges: Schema.Boolean,
  aheadCount: Schema.Number,
  behindCount: Schema.Number,
  updatedAt: IsoDateTimeSchema,
});

export type OrchestrationGitReadModel = Schema.Schema.Type<typeof OrchestrationGitReadModelSchema>;

export const OrchestrationReadModelSchema = Schema.Struct({
  sequence: Schema.Number,
  threads: Schema.Array(OrchestrationThreadSchema),
  gitByProjectId: Schema.Record( Schema.String,  OrchestrationGitReadModelSchema),
  updatedAt: IsoDateTimeSchema,
});

export type OrchestrationReadModel = Schema.Schema.Type<typeof OrchestrationReadModelSchema>;

export const CreateThreadCommandSchema = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: IdSchema,
  threadId: IdSchema,
  projectId: IdSchema,
  title: Schema.String,
  model: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTimeSchema,
});

export const DeleteThreadCommandSchema = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: IdSchema,
  threadId: IdSchema,
  createdAt: IsoDateTimeSchema,
});

export const UpdateThreadMetaCommandSchema = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: IdSchema,
  threadId: IdSchema,
  title: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: IsoDateTimeSchema,
});

export const SendMessageCommandSchema = Schema.Struct({
  type: Schema.Literal("message.send"),
  commandId: IdSchema,
  threadId: IdSchema,
  messageId: IdSchema,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  streaming: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTimeSchema,
});

export const SetThreadSessionSchema = Schema.Struct({
  type: Schema.Literal("thread.session"),
  commandId: IdSchema,
  threadId: IdSchema,
  session: OrchestrationSessionSchema,
  createdAt: IsoDateTimeSchema,
});

export const UpsertGitReadModelCommandSchema = Schema.Struct({
  type: Schema.Literal("git.readModel.upsert"),
  commandId: IdSchema,
  projectId: IdSchema,
  branch: Schema.NullOr(Schema.String),
  hasWorkingTreeChanges: Schema.Boolean,
  aheadCount: Schema.Number,
  behindCount: Schema.Number,
  createdAt: IsoDateTimeSchema,
});

export const CompleteThreadTurnDiffCommandSchema = Schema.Struct({
  type: Schema.Literal("thread.turnDiff.complete"),
  commandId: IdSchema,
  threadId: IdSchema,
  turnId: IdSchema,
  completedAt: IsoDateTimeSchema,
  status: Schema.optional(Schema.String),
  files: Schema.Array(OrchestrationTurnDiffFileSchema),
  assistantMessageId: Schema.optional(Schema.String),
  checkpointTurnCount: Schema.optional(Schema.Number),
  createdAt: IsoDateTimeSchema,
});

export const RevertThreadCommandSchema = Schema.Struct({
  type: Schema.Literal("thread.revert"),
  commandId: IdSchema,
  threadId: IdSchema,
  turnCount: Schema.Number,
  messageCount: Schema.Number,
  createdAt: IsoDateTimeSchema,
});

export const OrchestrationCommandSchema = Schema.Union([
  CreateThreadCommandSchema,
  DeleteThreadCommandSchema,
  UpdateThreadMetaCommandSchema,
  SendMessageCommandSchema,
  SetThreadSessionSchema,
  UpsertGitReadModelCommandSchema,
  CompleteThreadTurnDiffCommandSchema,
  RevertThreadCommandSchema,]
);

export type OrchestrationCommand = Schema.Schema.Type<typeof OrchestrationCommandSchema>;

export const OrchestrationEventSchema = Schema.Struct({
  sequence: Schema.Number,
  eventId: IdSchema,
  type: Schema.String,
  aggregateType: Schema.String,
  aggregateId: Schema.String,
  occurredAt: IsoDateTimeSchema,
  commandId: Schema.NullOr(Schema.String),
  payload: Schema.Unknown,
});

export type OrchestrationEvent = Schema.Schema.Type<typeof OrchestrationEventSchema>;

export const OrchestrationReadModelPushSchema = Schema.Struct({
  sequence: Schema.Number,
  snapshot: OrchestrationReadModelSchema,
});

export type OrchestrationReadModelPush = Schema.Schema.Type<typeof OrchestrationReadModelPushSchema>;
