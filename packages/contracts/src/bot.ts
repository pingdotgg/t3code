import * as Schema from "effect/Schema";

import { CommandId, ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const BotProfileFields = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  role: Schema.String.check(Schema.isMaxLength(120)),
  description: Schema.String.check(Schema.isMaxLength(500)),
  icon: Schema.String.check(Schema.isMaxLength(16)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  instructions: Schema.String.check(Schema.isMaxLength(3000)),
});

export const BotState = Schema.Literals(["active", "paused", "archived"]);
export type BotState = typeof BotState.Type;

export const BotAccess = Schema.Struct({
  writeSources: Schema.Array(Schema.Literals(["scheduled", "handoff", "webhook"])).check(
    Schema.isMaxLength(3),
  ),
  handoffProjects: Schema.Array(ProjectId).check(Schema.isMaxLength(64)),
});
export type BotAccess = typeof BotAccess.Type;

export const BotSetAccessInput = Schema.Struct({ threadId: ThreadId, access: BotAccess });

export const BotProfile = Schema.Struct({
  ...BotProfileFields.fields,
  threadId: ThreadId,
  projectId: ProjectId,
  state: BotState,
  access: BotAccess,
  revision: Schema.Int,
});
export type BotProfile = typeof BotProfile.Type;

export const BotList = Schema.Array(BotProfile);
export const BotCreateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  profile: BotProfileFields,
});

export const BotUpdateInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: Schema.Int,
  profile: BotProfileFields,
});

export const BotSetStateInput = Schema.Struct({ threadId: ThreadId, state: BotState });
export const BotRestoreInput = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.Int,
  expectedRevision: Schema.Int,
});

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  reason: Schema.Literals(["not_found", "conflict", "unsupported_provider", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "Bot or revision was not found.";
      case "conflict":
        return "The bot was changed while you were editing it.";
      case "unsupported_provider":
        return "This bot needs a Codex provider.";
      case "unavailable":
        return "The bot operation could not be completed.";
    }
  }
}

const BotDraftProfileChange = Schema.Struct({
  type: Schema.Literal("profile"),
  profile: BotProfileFields,
});

const BotDraftNewBot = Schema.Struct({
  type: Schema.Literal("bot"),
  profile: BotProfileFields,
});

const BotAutomationChangeFields = {
  replaceId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  enabled: Schema.optional(Schema.Boolean),
};

const BotDraftSchedule = Schema.Struct({
  type: Schema.Literal("schedule"),
  ...BotAutomationChangeFields,
  workflowId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  schedule: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("fixed_time"),
      timeOfDay: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
      weekdays: Schema.optional(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
      ),
    }),
    Schema.Struct({
      type: Schema.Literal("interval"),
      everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60000)),
    }),
  ]),
});

const WebhookField = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/),
);

const BotDraftHook = Schema.Struct({
  type: Schema.Literal("hook"),
  ...BotAutomationChangeFields,
  workflowId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  prompt: TrimmedNonEmptyString.check(
    Schema.isMaxLength(8000),
    Schema.isPattern(/^(?![\s\S]*\{\{)[\s\S]+$/),
  ),
  fields: Schema.Array(WebhookField).check(Schema.isMaxLength(16)),
  deliveryIdField: WebhookField,
});

const BotWorkStep = Schema.Struct({
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
});

const BotWorkflowDetails = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  steps: Schema.NonEmptyArray(BotWorkStep).check(Schema.isMaxLength(12)),
});

const BotDraftWorkflow = Schema.Struct({
  type: Schema.Literal("workflow"),
  ...BotAutomationChangeFields,
  ...BotWorkflowDetails.fields,
});

export const BotDraftChange = Schema.Union([
  BotDraftProfileChange,
  BotDraftNewBot,
  BotDraftSchedule,
  BotDraftHook,
  BotDraftWorkflow,
]);
export type BotDraftChange = typeof BotDraftChange.Type;

export const BotDraft = Schema.Struct({
  id: CommandId,
  authorThreadId: ThreadId,
  authorRevision: Schema.Int,
  change: BotDraftChange,
  decision: Schema.optional(Schema.Literals(["approved", "rejected"])),
  authorization: Schema.optional(
    Schema.Literals(["owner", "self", "direct", "scheduled", "handoff", "webhook"]),
  ),
  activatedId: Schema.optional(Schema.String),
});
export type BotDraft = typeof BotDraft.Type;

export const BotDraftList = Schema.Array(BotDraft);
export const BotDraftReviewInput = Schema.Struct({
  id: CommandId,
  decision: Schema.Literals(["approve", "reject"]),
});

export const BotProposeInput = Schema.Struct({
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  change: BotDraftChange,
});

export const BotGrantSource = Schema.Literals(["direct", "scheduled", "handoff", "webhook"]);
export type BotGrantSource = typeof BotGrantSource.Type;
export const BotGrantResource = Schema.Literals(["bot", "schedule", "hook", "workflow"]);
export type BotGrantResource = typeof BotGrantResource.Type;

export const BotGrant = Schema.Struct({
  threadId: ThreadId,
  resource: BotGrantResource,
  source: BotGrantSource,
});
export type BotGrant = typeof BotGrant.Type;

export const BotSetGrantInput = Schema.Struct({
  ...BotGrant.fields,
  enabled: Schema.Boolean,
});

export const BotConfiguration = Schema.Struct({
  drafts: BotDraftList,
  grants: Schema.Array(BotGrant),
});

const BotChannelDetails = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  members: Schema.NonEmptyArray(ThreadId).check(Schema.isMaxLength(16)),
  leader: Schema.NullOr(ThreadId),
});

const BotWorkflow = Schema.Struct({
  id: CommandId,
  projectId: ProjectId,
  type: Schema.Literal("workflow"),
  enabled: Schema.Boolean,
  ...BotWorkflowDetails.fields,
});

const BotChannel = Schema.Struct({
  id: CommandId,
  projectId: ProjectId,
  type: Schema.Literal("channel"),
  ...BotChannelDetails.fields,
});

export const BotCollection = Schema.Union([BotWorkflow, BotChannel]);
export type BotCollection = typeof BotCollection.Type;

export const BotWorkRun = Schema.Struct({
  id: CommandId,
  collectionId: CommandId,
  rootId: CommandId,
  ancestry: Schema.Array(ThreadId),
  source: BotGrantSource,
  input: Schema.String,
  steps: Schema.Array(BotWorkStep),
  outputs: Schema.Array(Schema.Struct({ threadId: ThreadId, runId: RunId, text: Schema.String })),
  targetThreadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  step: Schema.Int,
  attempt: Schema.Int,
  status: Schema.Literals(["waiting", "running", "failed", "completed"]),
});
export type BotWorkRun = typeof BotWorkRun.Type;

export const BotWorkSnapshot = Schema.Struct({
  collections: Schema.Array(BotCollection),
  runs: Schema.Array(BotWorkRun),
});

export const BotWorkAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("save_channel"),
    id: CommandId,
    projectId: ProjectId,
    ...BotChannelDetails.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("save_workflow"),
    id: CommandId,
    projectId: ProjectId,
    ...BotWorkflowDetails.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("start"),
    id: CommandId,
    collectionId: CommandId,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
    mention: Schema.optional(ThreadId),
  }),
  Schema.Struct({ type: Schema.Literal("retry"), id: CommandId }),
]);

export const BotAssignInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  target: ThreadId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
});
