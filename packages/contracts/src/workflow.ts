import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";

export const WORKFLOW_WS_METHODS = {
  listBoards: "workflow.listBoards",
  createBoard: "workflow.createBoard",
  deleteBoard: "workflow.deleteBoard",
  renameBoard: "workflow.renameBoard",
  getBoard: "workflow.getBoard",
  getBoardDefinition: "workflow.getBoardDefinition",
  saveBoardDefinition: "workflow.saveBoardDefinition",
  listBoardVersions: "workflow.listBoardVersions",
  getBoardVersion: "workflow.getBoardVersion",
  subscribeBoard: "workflow.subscribeBoard",
  createTicket: "workflow.createTicket",
  editTicket: "workflow.editTicket",
  moveTicket: "workflow.moveTicket",
  runLane: "workflow.runLane",
  resolveApproval: "workflow.resolveApproval",
  answerTicketStep: "workflow.answerTicketStep",
  postTicketMessage: "workflow.postTicketMessage",
  editTicketMessage: "workflow.editTicketMessage",
  setProjectScriptTrust: "workflow.setProjectScriptTrust",
  cancelStep: "workflow.cancelStep",
  getTicketDetail: "workflow.getTicketDetail",
  getTicketDiff: "workflow.getTicketDiff",
  intakeTickets: "workflow.intakeTickets",
  listTicketArtifacts: "workflow.listTicketArtifacts",
  getWebhookConfig: "workflow.getWebhookConfig",
  getBoardDigest: "workflow.getBoardDigest",
  dryRunBoard: "workflow.dryRunBoard",
  listNeedsAttentionTickets: "workflow.listNeedsAttentionTickets",
  listWorkSourceConnections: "workflow.listWorkSourceConnections",
  createWorkSourceConnection: "workflow.createWorkSourceConnection",
  deleteWorkSourceConnection: "workflow.deleteWorkSourceConnection",
  listOutboundConnections: "workflow.listOutboundConnections",
  createOutboundConnection: "workflow.createOutboundConnection",
  deleteOutboundConnection: "workflow.deleteOutboundConnection",
  getBoardMetrics: "workflow.getBoardMetrics",
  importBoard: "workflow.importBoard",
  proposeBoardImprovement: "workflow.proposeBoardImprovement",
  listBoardProposals: "workflow.listBoardProposals",
  getBoardProposal: "workflow.getBoardProposal",
  resolveBoardProposal: "workflow.resolveBoardProposal",
  revertBoardProposal: "workflow.revertBoardProposal",
  createWorkflowBoard: "workflow.createWorkflowBoard",
  generateWorkflowDraft: "workflow.generateWorkflowDraft",
  listBoardTemplates: "workflow.listBoardTemplates",
  listImportableWorkItems: "workflow.listImportableWorkItems",
  importWorkItems: "workflow.importWorkItems",
} as const;

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const BoardId = makeId("BoardId");
export type BoardId = typeof BoardId.Type;

export const TicketId = makeId("TicketId");
export type TicketId = typeof TicketId.Type;

export const PipelineRunId = makeId("PipelineRunId");
export type PipelineRunId = typeof PipelineRunId.Type;

export const StepRunId = makeId("StepRunId");
export type StepRunId = typeof StepRunId.Type;

export const SetupRunId = makeId("SetupRunId");
export type SetupRunId = typeof SetupRunId.Type;

export const ScriptRunId = makeId("ScriptRunId");
export type ScriptRunId = typeof ScriptRunId.Type;

export const DispatchId = makeId("DispatchId");
export type DispatchId = typeof DispatchId.Type;

export const LaneEntryToken = makeId("LaneEntryToken");
export type LaneEntryToken = typeof LaneEntryToken.Type;

export const WorkflowEventId = makeId("WorkflowEventId");
export type WorkflowEventId = typeof WorkflowEventId.Type;

export const LaneKey = TrimmedNonEmptyString.pipe(Schema.brand("LaneKey"));
export type LaneKey = typeof LaneKey.Type;

export const StepKey = TrimmedNonEmptyString.pipe(Schema.brand("StepKey"));
export type StepKey = typeof StepKey.Type;

export const WorkflowBoardName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type WorkflowBoardName = typeof WorkflowBoardName.Type;

export const StepInstruction = Schema.Union([
  Schema.String,
  Schema.Struct({ file: TrimmedNonEmptyString }),
]);
export type StepInstruction = typeof StepInstruction.Type;

export const AgentSelection = Schema.Struct({
  instance: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  // Reasoning effort / provider option selections (the same shape the chat
  // composer dispatches), applied when this agent step runs. Canonical array
  // form only — this is a new field, so there is no legacy object form to
  // tolerate.
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
});
export type AgentSelection = typeof AgentSelection.Type;

export const StepRetryEscalation = Schema.Struct({
  instance: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
});
export type StepRetryEscalation = typeof StepRetryEscalation.Type;

export const StepRetryPolicy = Schema.Struct({
  // Total attempts including the first run. Lint enforces 2..5; the engine
  // additionally clamps so a hand-edited file cannot retry unboundedly.
  maxAttempts: Schema.Int,
  escalate: Schema.optional(StepRetryEscalation),
});
export type StepRetryPolicy = typeof StepRetryPolicy.Type;

export const WorkflowStepType = Schema.Union([
  Schema.Literal("agent"),
  Schema.Literal("approval"),
  Schema.Literal("script"),
  Schema.Literal("merge"),
  Schema.Literal("pullRequest"),
]);
export type WorkflowStepType = typeof WorkflowStepType.Type;

export const StepRouting = Schema.Struct({
  success: Schema.optional(LaneKey),
  failure: Schema.optional(LaneKey),
  blocked: Schema.optional(LaneKey),
});
export type StepRouting = typeof StepRouting.Type;

export const AgentStep = Schema.Struct({
  key: StepKey,
  type: Schema.Literal("agent"),
  agent: AgentSelection,
  instruction: StepInstruction,
  captureOutput: Schema.optional(Schema.Boolean),
  // Resume this agent's own provider session across steps/loops within the
  // lane, reusing a stable workflow threadId per (ticket, lane, agentKey).
  // Capability-gated to resumable providers; incompatible with a panel.
  continueSession: Schema.optional(Schema.Boolean),
  // Reviewer panel: run this many independent turns of the same step and
  // take the majority verdict from their captured outputs. Requires
  // captureOutput; lint enforces 2..5.
  panel: Schema.optional(Schema.Int),
  retry: Schema.optional(StepRetryPolicy),
  on: Schema.optional(StepRouting),
});

export const ApprovalStep = Schema.Struct({
  key: StepKey,
  type: Schema.Literal("approval"),
  prompt: Schema.optional(Schema.String),
  on: Schema.optional(StepRouting),
});

export const ScriptStep = Schema.Struct({
  key: StepKey,
  type: Schema.Literal("script"),
  run: TrimmedNonEmptyString,
  timeout: Schema.optional(Schema.DurationFromString),
  cwd: Schema.optional(Schema.String),
  allowFailure: Schema.optional(Schema.Boolean),
  retry: Schema.optional(StepRetryPolicy),
  on: Schema.optional(StepRouting),
});
export type ScriptStep = typeof ScriptStep.Type;

export const MergeStep = Schema.Struct({
  key: StepKey,
  type: Schema.Literal("merge"),
  // Branch that must be checked out at the repo root for the merge to run;
  // when unset the merge lands on whatever branch is currently checked out.
  // The engine never switches the user's branch.
  target: Schema.optional(TrimmedNonEmptyString),
  commitMessage: Schema.optional(Schema.String),
  // Repo-relative working files (e.g. PLAN.md / REVIEW.md) removed from the
  // worktree before the snapshot commit so they never land in the target
  // branch.
  cleanupPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  on: Schema.optional(StepRouting),
});
export type MergeStep = typeof MergeStep.Type;

export const PullRequestStep = Schema.Struct({
  key: StepKey,
  type: Schema.Literal("pullRequest"),
  action: Schema.Literals(["open", "land"]),
  // action: "open" — base defaults to the repo's default branch (resolved
  // via gh at run time); templates use the standard {{ticket.*}} placeholders.
  base: Schema.optional(TrimmedNonEmptyString),
  draft: Schema.optional(Schema.Boolean),
  titleTemplate: Schema.optional(TrimmedNonEmptyString),
  bodyTemplate: Schema.optional(Schema.String),
  // action: "land"
  strategy: Schema.optional(Schema.Literals(["squash", "merge", "rebase"])),
  deleteBranch: Schema.optional(Schema.Boolean),
  on: Schema.optional(StepRouting),
});
export type PullRequestStep = typeof PullRequestStep.Type;

export const WorkflowStep = Schema.Union([
  AgentStep,
  ApprovalStep,
  ScriptStep,
  MergeStep,
  PullRequestStep,
]);
export type WorkflowStep = typeof WorkflowStep.Type;

export const LaneEntry = Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]);
export type LaneEntry = typeof LaneEntry.Type;

export const LaneRouting = Schema.Struct({
  success: Schema.optional(LaneKey),
  failure: Schema.optional(LaneKey),
  blocked: Schema.optional(LaneKey),
});
export type LaneRouting = typeof LaneRouting.Type;

export const JsonLogicRule = Schema.Unknown;
export type JsonLogicRule = typeof JsonLogicRule.Type;

export const WorkflowLaneTransition = Schema.Struct({
  when: JsonLogicRule,
  to: LaneKey,
});
export type WorkflowLaneTransition = typeof WorkflowLaneTransition.Type;

// A human-facing transition out of a lane, rendered as a button on tickets
// in that lane ("Approve & land", "Send back", …). Purely declarative sugar
// over moveTicket — the engine treats it like any manual move.
export const WorkflowLaneAction = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  to: LaneKey,
  hint: Schema.optional(Schema.String.check(Schema.isMaxLength(160))),
});
export type WorkflowLaneAction = typeof WorkflowLaneAction.Type;

// An external-event matcher: when a webhook event with this name correlates
// to a ticket sitting in this lane (and the optional predicate over
// {event: {name, payload}} passes), the ticket moves to `to`.
export const WorkflowLaneEvent = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  when: Schema.optional(JsonLogicRule),
  to: LaneKey,
});
export type WorkflowLaneEvent = typeof WorkflowLaneEvent.Type;

export const WorkflowLane = Schema.Struct({
  key: LaneKey,
  name: TrimmedNonEmptyString,
  entry: LaneEntry,
  actions: Schema.optional(Schema.Array(WorkflowLaneAction)),
  onEvent: Schema.optional(Schema.Array(WorkflowLaneEvent)),
  pipeline: Schema.optional(Schema.Array(WorkflowStep)),
  on: Schema.optional(LaneRouting),
  transitions: Schema.optional(Schema.Array(WorkflowLaneTransition)),
  wipLimit: Schema.optional(Schema.Int),
  color: Schema.optional(Schema.String),
  terminal: Schema.optional(Schema.Boolean),
  retention: Schema.optional(Schema.DurationFromString),
});
export type WorkflowLane = typeof WorkflowLane.Type;

export const WorkflowSettings = Schema.Struct({
  maxConcurrentTickets: Schema.optional(Schema.Int),
});
export type WorkflowSettings = typeof WorkflowSettings.Type;

// ── Work-source types (defined here to avoid an import cycle: workSource.ts
//    imports LaneKey from this file, so this file must not import from
//    workSource.ts). workSource.ts re-exports these for convenience. ──────────

const _SourceId = TrimmedNonEmptyString.pipe(Schema.brand("SourceId"));
/** Branded schema for a work-source identifier. `SourceId.is(v)` is a type guard. */
export const SourceId = Object.assign(_SourceId, { is: Schema.is(_SourceId) });
export type SourceId = typeof _SourceId.Type;

export const WorkSourceProviderName = Schema.Literals(["github", "asana", "jira"]);
export type WorkSourceProviderName = typeof WorkSourceProviderName.Type;

export const WorkSourceAutoPull = Schema.Struct({ rule: JsonLogicRule });
export type WorkSourceAutoPull = typeof WorkSourceAutoPull.Type;

export const WorkflowSourceConfig = Schema.Struct({
  id: SourceId,
  provider: WorkSourceProviderName,
  connectionRef: TrimmedNonEmptyString,
  selector: Schema.Unknown, // validated against the provider's selector schema by lint
  destinationLane: LaneKey,
  closedLane: LaneKey,
  enabled: Schema.optional(Schema.Boolean),
  syncIntervalSec: Schema.optional(Schema.Int),
  autoPull: Schema.optional(WorkSourceAutoPull),
});
export type WorkflowSourceConfig = typeof WorkflowSourceConfig.Type;

// ─────────────────────────────────────────────────────────────────────────────

export const OutboundRuleId = makeId("OutboundRuleId");
export type OutboundRuleId = typeof OutboundRuleId.Type;

export const OutboundTrigger = Schema.Literals([
  "needs_attention",
  "blocked",
  "done",
  "lane_entered",
]);
export type OutboundTrigger = typeof OutboundTrigger.Type;

export const OutboundFormatter = Schema.Literals(["generic", "slack"]);
export type OutboundFormatter = typeof OutboundFormatter.Type;

export const WorkflowOutboundRule = Schema.Struct({
  id: OutboundRuleId,
  on: OutboundTrigger,
  when: Schema.optional(JsonLogicRule),
  to: TrimmedNonEmptyString,
  as: OutboundFormatter,
  enabled: Schema.Boolean,
});
export type WorkflowOutboundRule = typeof WorkflowOutboundRule.Type;

export const WorkflowDefinition = Schema.Struct({
  name: WorkflowBoardName,
  settings: Schema.optional(WorkflowSettings),
  sources: Schema.optional(Schema.Array(WorkflowSourceConfig)),
  outbound: Schema.optional(Schema.Array(WorkflowOutboundRule)),
  lanes: Schema.Array(WorkflowLane),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowDefinitionEncoded = Schema.toEncoded(WorkflowDefinition);
export type WorkflowDefinitionEncoded = typeof WorkflowDefinitionEncoded.Type;

export const WorkflowLintCode = Schema.Union([
  Schema.Literal("duplicate_lane_key"),
  Schema.Literal("duplicate_step_key"),
  Schema.Literal("missing_lane_ref"),
  Schema.Literal("unknown_provider_instance"),
  Schema.Literal("missing_instruction_file"),
  Schema.Literal("unsafe_instruction_path"),
  Schema.Literal("auto_lane_cycle"),
  Schema.Literal("unreachable_terminal"),
  Schema.Literal("invalid_json_logic"),
  Schema.Literal("unknown_predicate_path"),
  Schema.Literal("unsafe_step_key"),
  Schema.Literal("invalid_wip_limit"),
  Schema.Literal("invalid_retention"),
  Schema.Literal("invalid_retry"),
  Schema.Literal("invalid_panel"),
  Schema.Literal("unknown_template_placeholder"),
  Schema.Literal("invalid_step"),
  Schema.Literal("invalid_source"),
  Schema.Literal("duplicate_source_id"),
  Schema.Literal("invalid_outbound"),
  Schema.Literal("duplicate_outbound_id"),
  Schema.Literal("invalid_continue_session"),
  Schema.Literal("invalid_handoff_reference"),
]);
export type WorkflowLintCode = typeof WorkflowLintCode.Type;

export const WorkflowLintError = Schema.Struct({
  code: WorkflowLintCode,
  message: Schema.String,
  laneKey: Schema.optional(LaneKey),
  stepKey: Schema.optional(StepKey),
  transitionIndex: Schema.optional(Schema.Int),
});
export type WorkflowLintError = typeof WorkflowLintError.Type;

export const WorkflowGetBoardDefinitionResult = Schema.Struct({
  definition: WorkflowDefinitionEncoded,
  versionHash: Schema.String,
});
export type WorkflowGetBoardDefinitionResult = typeof WorkflowGetBoardDefinitionResult.Type;

export const WorkflowCreateBoardInput = Schema.Struct({
  projectId: ProjectId,
  name: WorkflowBoardName,
  agent: AgentSelection,
});
export type WorkflowCreateBoardInput = typeof WorkflowCreateBoardInput.Type;

export const WorkflowRenameBoardInput = Schema.Struct({
  boardId: BoardId,
  name: WorkflowBoardName,
});
export type WorkflowRenameBoardInput = typeof WorkflowRenameBoardInput.Type;

export const WorkflowBoardVersionSource = Schema.Literals([
  "create",
  "save",
  "revert",
  "import",
  "rename",
  "self-improve",
  "self-improve-revert",
]);
export type WorkflowBoardVersionSource = typeof WorkflowBoardVersionSource.Type;

export const WorkflowBoardVersionSummary = Schema.Struct({
  versionId: Schema.Int,
  versionHash: Schema.String,
  source: WorkflowBoardVersionSource,
  createdAt: IsoDateTime,
  isCurrent: Schema.Boolean,
});
export type WorkflowBoardVersionSummary = typeof WorkflowBoardVersionSummary.Type;

export const WorkflowGetBoardVersionResult = Schema.Struct({
  versionId: Schema.Int,
  definition: WorkflowDefinitionEncoded,
  versionHash: Schema.String,
  source: WorkflowBoardVersionSource,
  createdAt: IsoDateTime,
});
export type WorkflowGetBoardVersionResult = typeof WorkflowGetBoardVersionResult.Type;

const EventBase = {
  eventId: WorkflowEventId,
  ticketId: TicketId,
  streamVersion: Schema.Int,
  occurredAt: IsoDateTime,
};

export const TicketStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("running"),
  Schema.Literal("waiting_on_user"),
  Schema.Literal("blocked"),
  Schema.Literal("queued"),
  Schema.Literal("done"),
  Schema.Literal("failed"),
]);
export type TicketStatus = typeof TicketStatus.Type;

// Intentional copy — keep in sync with WorkflowTicketAttentionKind in relay.ts.
export const WorkflowTicketAttentionKind = Schema.Literals([
  "waiting_for_approval",
  "waiting_for_input",
  "blocked",
]);
export type WorkflowTicketAttentionKind = typeof WorkflowTicketAttentionKind.Type;

export const StepRunStatus = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("dispatch_requested"),
  Schema.Literal("running"),
  Schema.Literal("awaiting_user"),
  Schema.Literal("completed"),
  Schema.Literal("failed"),
  Schema.Literal("blocked"),
  Schema.Literal("superseded"),
]);
export type StepRunStatus = typeof StepRunStatus.Type;

export const ScriptRunStatus = Schema.Union([
  Schema.Literal("running"),
  Schema.Literal("exited"),
  Schema.Literal("timeout"),
  Schema.Literal("cancelled"),
]);
export type ScriptRunStatus = typeof ScriptRunStatus.Type;

const TicketAttachmentId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const TicketAttachmentName = TrimmedNonEmptyString.check(Schema.isMaxLength(255));
const TicketAttachmentMimeType = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const TicketRasterImageMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
// Cap raw bytes at ~10 MiB to stay consistent with the dataUrl length cap below
// (14M base64 chars ≈ 10 MiB of raw image data) and with the server's enforced
// MAX_TICKET_ANSWER_ATTACHMENT_BYTES (10 * 1024 * 1024). A higher sizeBytes cap
// would advertise a limit that the dataUrl check and server both reject anyway.
const TicketAttachmentSizeBytes = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(10 * 1024 * 1024),
);
const TicketAttachmentRef = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const TicketImageDataUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(14_000_000),
  Schema.isPattern(/^data:image\/(?:png|jpeg|gif|webp);base64,/i),
);

export const TicketImageAttachment = Schema.Struct({
  kind: Schema.Literal("image"),
  id: TicketAttachmentId,
  name: TicketAttachmentName,
  mimeType: TicketRasterImageMimeType,
  sizeBytes: TicketAttachmentSizeBytes,
  dataUrl: TicketImageDataUrl,
});
export type TicketImageAttachment = typeof TicketImageAttachment.Type;

export const TicketVideoAttachment = Schema.Struct({
  kind: Schema.Literal("video"),
  id: TicketAttachmentId,
  name: TicketAttachmentName,
  mimeType: TicketAttachmentMimeType,
  sizeBytes: TicketAttachmentSizeBytes,
  ref: TicketAttachmentRef,
});
export type TicketVideoAttachment = typeof TicketVideoAttachment.Type;

export const TicketFileAttachment = Schema.Struct({
  kind: Schema.Literal("file"),
  id: TicketAttachmentId,
  name: TicketAttachmentName,
  mimeType: TicketAttachmentMimeType,
  sizeBytes: TicketAttachmentSizeBytes,
  ref: TicketAttachmentRef,
});
export type TicketFileAttachment = typeof TicketFileAttachment.Type;

export const TicketAttachment = Schema.Union([
  TicketImageAttachment,
  TicketVideoAttachment,
  TicketFileAttachment,
]);
export type TicketAttachment = typeof TicketAttachment.Type;

export const WorkflowStepUsage = Schema.Struct({
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
});
export type WorkflowStepUsage = typeof WorkflowStepUsage.Type;

export const WorkflowEvent = Schema.Union([
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketCreated"),
    payload: Schema.Struct({
      boardId: BoardId,
      title: TrimmedNonEmptyString,
      laneKey: LaneKey,
      description: Schema.optional(Schema.String),
      // Soft cap on provider tokens this ticket may consume; agent steps
      // block (not fail) once the roll-up reaches it.
      tokenBudget: Schema.optional(NonNegativeInt),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketEdited"),
    payload: Schema.Struct({
      title: Schema.optional(TrimmedNonEmptyString),
      description: Schema.optional(Schema.String),
      // Null clears the budget; absent leaves it unchanged.
      tokenBudget: Schema.optional(Schema.NullOr(NonNegativeInt)),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketDependenciesSet"),
    // Full-set semantics: replaces the ticket's blocked-by edges.
    payload: Schema.Struct({
      dependsOn: Schema.Array(TicketId),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketMessagePosted"),
    payload: Schema.Struct({
      messageId: MessageId,
      stepRunId: Schema.optional(StepRunId),
      author: Schema.Literals(["agent", "user"]),
      body: Schema.String,
      attachments: Schema.Array(TicketAttachment),
      createdAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketMessageEdited"),
    payload: Schema.Struct({
      messageId: MessageId,
      body: Schema.String,
      editedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketMovedToLane"),
    payload: Schema.Struct({
      toLane: LaneKey,
      laneEntryToken: LaneEntryToken,
      reason: Schema.Union([
        Schema.Literal("manual"),
        Schema.Literal("routed"),
        Schema.Literal("initial"),
        Schema.Literal("external"),
      ]),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketQueued"),
    payload: Schema.Struct({
      lane: LaneKey,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketAdmitted"),
    payload: Schema.Struct({
      lane: LaneKey,
      laneEntryToken: LaneEntryToken,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketBlocked"),
    payload: Schema.Struct({ reason: Schema.String }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("PipelineStarted"),
    payload: Schema.Struct({
      pipelineRunId: PipelineRunId,
      laneKey: LaneKey,
      laneEntryToken: LaneEntryToken,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("PipelineCompleted"),
    payload: Schema.Struct({
      pipelineRunId: PipelineRunId,
      result: Schema.Union([
        Schema.Literal("success"),
        Schema.Literal("failure"),
        Schema.Literal("blocked"),
        Schema.Literal("superseded"),
      ]),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepStarted"),
    payload: Schema.Struct({
      pipelineRunId: PipelineRunId,
      stepRunId: StepRunId,
      stepKey: StepKey,
      stepType: WorkflowStepType,
      attempt: Schema.optional(Schema.Int),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepAwaitingUser"),
    payload: Schema.Struct({
      stepRunId: StepRunId,
      waitingReason: Schema.String,
      providerThreadId: Schema.optional(ThreadId),
      providerRequestId: Schema.optional(ApprovalRequestId),
      providerResponseKind: Schema.optional(Schema.Literals(["request", "user-input"])),
      providerQuestionId: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepUserResolved"),
    payload: Schema.Struct({ stepRunId: StepRunId }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepRefsCaptured"),
    payload: Schema.Struct({
      stepRunId: StepRunId,
      preRef: Schema.String,
      postRef: Schema.String,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepCompleted"),
    payload: Schema.Struct({
      stepRunId: StepRunId,
      output: Schema.optional(Schema.Unknown),
      usage: Schema.optional(WorkflowStepUsage),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepFailed"),
    payload: Schema.Struct({
      stepRunId: StepRunId,
      error: Schema.String,
      // Persisted so crash recovery cannot auto-retry user-initiated
      // rejections/cancellations; absent means retry-eligible.
      retryable: Schema.optional(Schema.Boolean),
      usage: Schema.optional(WorkflowStepUsage),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("StepBlocked"),
    payload: Schema.Struct({ stepRunId: StepRunId, reason: Schema.String }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("ScriptStepStarted"),
    payload: Schema.Struct({
      scriptRunId: ScriptRunId,
      stepRunId: StepRunId,
      scriptThreadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("ScriptStepExited"),
    payload: Schema.Struct({
      scriptRunId: ScriptRunId,
      exitCode: Schema.NullOr(Schema.Int),
      signal: Schema.NullOr(Schema.Int),
      outcome: Schema.Union([
        Schema.Literal("exited"),
        Schema.Literal("timeout"),
        Schema.Literal("cancelled"),
      ]),
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketRouted"),
    payload: Schema.Struct({ fromLane: LaneKey, toLane: LaneKey }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketRouteDecided"),
    payload: Schema.Struct({
      // Absent for external events — they have no pipeline run.
      pipelineRunId: Schema.optional(PipelineRunId),
      fromLane: LaneKey,
      toLane: LaneKey,
      source: Schema.Union([
        Schema.Literal("step_on"),
        Schema.Literal("lane_transition"),
        Schema.Literal("lane_on"),
        Schema.Literal("external_event"),
        Schema.Literal("work_source"),
      ]),
      matchedTransitionIndex: Schema.optional(Schema.Int),
      contextSnapshot: Schema.Unknown,
    }),
  }),
  Schema.Struct({
    ...EventBase,
    type: Schema.Literal("TicketPrOpened"),
    payload: Schema.Struct({
      stepRunId: StepRunId,
      prNumber: Schema.Int,
      url: Schema.String,
      branch: Schema.String,
      remoteName: Schema.String,
      repo: Schema.String, // owner/name resolved at open time
    }),
  }),
]);
export type WorkflowEvent = typeof WorkflowEvent.Type;

export const StepOutcome = Schema.Union([
  Schema.TaggedStruct("completed", {
    output: Schema.optional(Schema.Unknown),
    usage: Schema.optional(WorkflowStepUsage),
  }),
  Schema.TaggedStruct("failed", {
    error: Schema.String,
    // false marks failures that must never be auto-retried (user-initiated
    // cancellations); absent/true failures are eligible for step retry.
    retryable: Schema.optional(Schema.Boolean),
    usage: Schema.optional(WorkflowStepUsage),
  }),
  Schema.TaggedStruct("blocked", { reason: Schema.String }),
  Schema.TaggedStruct("awaiting_user", {
    waitingReason: Schema.String,
    providerThreadId: Schema.optional(ThreadId),
    providerRequestId: Schema.optional(ApprovalRequestId),
    providerResponseKind: Schema.optional(Schema.Literals(["request", "user-input"])),
    providerQuestionId: Schema.optional(Schema.String),
  }),
]);
export type StepOutcome = typeof StepOutcome.Type;

export const TicketDiffFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type TicketDiffFile = typeof TicketDiffFile.Type;

export const TicketDiff = Schema.Struct({
  ticketId: TicketId,
  baseRef: Schema.String,
  patch: Schema.String,
  files: Schema.Array(TicketDiffFile),
  truncated: Schema.Boolean,
});
export type TicketDiff = typeof TicketDiff.Type;

export const TicketPrView = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  ciState: Schema.optional(Schema.Literals(["pending", "success", "failure"])),
});
export type TicketPrView = typeof TicketPrView.Type;

export const WorkflowLaneActionView = Schema.Struct({
  label: Schema.String,
  to: LaneKey,
  hint: Schema.optional(Schema.String),
});
export type WorkflowLaneActionView = typeof WorkflowLaneActionView.Type;

export const WorkflowCurrentLaneView = Schema.Struct({
  key: LaneKey,
  name: Schema.String,
  actions: Schema.Array(WorkflowLaneActionView),
});
export type WorkflowCurrentLaneView = typeof WorkflowCurrentLaneView.Type;

export const BoardTicketView = Schema.Struct({
  ticketId: TicketId,
  boardId: BoardId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  currentLaneKey: LaneKey,
  status: TicketStatus,
  queuedAt: Schema.optional(Schema.String),
  totalTokens: Schema.optional(NonNegativeInt),
  totalDurationMs: Schema.optional(NonNegativeInt),
  dependsOn: Schema.optional(Schema.Array(TicketId)),
  // Dependencies whose ticket has not reached a terminal lane yet. Admission
  // skips the ticket while this is > 0.
  unresolvedDependencyCount: Schema.optional(NonNegativeInt),
  tokenBudget: Schema.optional(NonNegativeInt),
  // Last projection update — drives "waiting on you for N hours" aging.
  updatedAt: Schema.optional(Schema.String),
  pr: Schema.optional(TicketPrView),
  // Attention fields — present when the ticket needs human attention.
  attentionKind: Schema.optional(WorkflowTicketAttentionKind),
  attentionReason: Schema.optional(Schema.String),
  // Current lane detail — present when the server includes it for attention views.
  currentLane: Schema.optional(WorkflowCurrentLaneView),
});
export type BoardTicketView = typeof BoardTicketView.Type;

export const WorkflowNeedsAttentionTicketView = Schema.Struct({
  ticketId: TicketId,
  boardId: BoardId,
  boardName: Schema.String,
  title: Schema.String,
  status: TicketStatus,
  currentLaneKey: LaneKey,
  attentionKind: Schema.NullOr(WorkflowTicketAttentionKind),
  attentionReason: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type WorkflowNeedsAttentionTicketView = typeof WorkflowNeedsAttentionTicketView.Type;

export const WorkflowTicketMessageView = Schema.Struct({
  messageId: MessageId,
  ticketId: TicketId,
  stepRunId: Schema.optional(StepRunId),
  author: Schema.Literals(["agent", "user"]),
  body: Schema.String,
  attachments: Schema.Array(TicketAttachment),
  createdAt: IsoDateTime,
  editedAt: Schema.optional(IsoDateTime),
});
export type WorkflowTicketMessageView = typeof WorkflowTicketMessageView.Type;

export const BoardSnapshot = Schema.Struct({
  projectId: ProjectId,
  board: Schema.Struct({
    boardId: BoardId,
    name: Schema.String,
    lanes: Schema.Array(
      Schema.Struct({
        key: LaneKey,
        name: Schema.String,
        entry: LaneEntry,
        pipelineStepCount: Schema.Int,
        wipLimit: Schema.optional(Schema.Int),
        terminal: Schema.optional(Schema.Boolean),
        actions: Schema.optional(Schema.Array(WorkflowLaneAction)),
      }),
    ),
  }),
  tickets: Schema.Array(BoardTicketView),
});
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const WorkflowSaveBoardDefinitionInput = Schema.Struct({
  boardId: BoardId,
  definition: WorkflowDefinitionEncoded,
  expectedVersionHash: Schema.String,
  source: Schema.optional(
    Schema.Literals(["save", "revert", "self-improve", "self-improve-revert"]),
  ),
});
export type WorkflowSaveBoardDefinitionInput = typeof WorkflowSaveBoardDefinitionInput.Type;

// The two ok:false members share the ok:false discriminant and are disambiguated
// only by their distinct required fields: the lint member by the required
// `lintErrors`, the conflict member by the required `conflict: true` +
// `currentVersionHash` (neither object validates the other member). Consumers rely
// on this (WorkflowEditor.tsx discriminates via `"lintErrors" in` / `"conflict" in`).
// INVARIANT: keep `lintErrors` required and `conflict`/`currentVersionHash`
// required — making either optional would let a conflict result decode as an empty
// lint result and silently drop the optimistic-concurrency signal.
export const WorkflowSaveBoardDefinitionResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    definition: WorkflowDefinitionEncoded,
    versionHash: Schema.String,
    snapshot: BoardSnapshot,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    lintErrors: Schema.Array(WorkflowLintError),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    conflict: Schema.Literal(true),
    currentVersionHash: Schema.String,
  }),
]);
export type WorkflowSaveBoardDefinitionResult = typeof WorkflowSaveBoardDefinitionResult.Type;

export const WorkflowImportBoardInput = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinitionEncoded,
});
export type WorkflowImportBoardInput = typeof WorkflowImportBoardInput.Type;

export const WorkflowImportBoardResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    boardId: BoardId,
    warnings: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), lintErrors: Schema.Array(WorkflowLintError) }),
]);
export type WorkflowImportBoardResult = typeof WorkflowImportBoardResult.Type;

export const BoardListEntry = Schema.Struct({
  boardId: BoardId,
  name: Schema.String,
  filePath: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type BoardListEntry = typeof BoardListEntry.Type;

export const BoardStreamItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), snapshot: BoardSnapshot }),
  Schema.Struct({ kind: Schema.Literal("ticket"), ticket: BoardTicketView }),
]);
export type BoardStreamItem = typeof BoardStreamItem.Type;

export const WorkflowStepRunView = Schema.Struct({
  stepRunId: StepRunId,
  stepKey: StepKey,
  stepType: WorkflowStepType,
  attempt: Schema.optional(Schema.Int),
  status: StepRunStatus,
  waitingReason: Schema.NullOr(Schema.String),
  blockedReason: Schema.NullOr(Schema.String),
  providerResponseKind: Schema.optional(Schema.NullOr(Schema.Literals(["request", "user-input"]))),
  scriptThreadId: Schema.NullOr(ThreadId),
  terminalId: Schema.NullOr(Schema.String),
  scriptStatus: Schema.NullOr(ScriptRunStatus),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.Int),
  output: Schema.optional(Schema.Unknown),
  startedAt: Schema.optional(IsoDateTime),
  finishedAt: Schema.optional(IsoDateTime),
  usage: Schema.optional(WorkflowStepUsage),
  // Latest dispatch thread for agent steps — lets the UI stream the live
  // provider activity for a running step.
  providerThreadId: Schema.optional(ThreadId),
});
export type WorkflowStepRunView = typeof WorkflowStepRunView.Type;

export const WorkflowRouteStepSnapshotView = Schema.Struct({
  status: Schema.String,
  exitCode: Schema.optional(Schema.Int),
  // Bounded highlight of the captured output — never the raw payload, which
  // can be arbitrarily large and is already visible on the step run itself.
  verdict: Schema.optional(Schema.String),
});
export type WorkflowRouteStepSnapshotView = typeof WorkflowRouteStepSnapshotView.Type;

/**
 * One entry in a ticket's routing history — why the ticket arrived in a lane.
 * Automatic routes carry the decision source and the routing-context snapshot
 * highlights; manual moves only record the destination.
 */
export const WorkflowRouteDecisionView = Schema.Struct({
  occurredAt: IsoDateTime,
  fromLane: Schema.optional(LaneKey),
  toLane: LaneKey,
  source: Schema.Literals([
    "step_on",
    "lane_transition",
    "lane_on",
    "manual",
    "external_event",
    "work_source",
  ]),
  matchedTransitionIndex: Schema.optional(Schema.Int),
  // For external_event decisions: the inbound event name.
  eventName: Schema.optional(Schema.String),
  pipelineResult: Schema.optional(Schema.Literals(["success", "failure", "blocked"])),
  laneRunCount: Schema.optional(Schema.Int),
  steps: Schema.optional(Schema.Record(Schema.String, WorkflowRouteStepSnapshotView)),
});
export type WorkflowRouteDecisionView = typeof WorkflowRouteDecisionView.Type;

// A ticket the intake agent proposes from a braindump; the user reviews and
// approves before anything is created.
export const WorkflowTicketProposal = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  // Indices of EARLIER proposals in the same intake result this one depends
  // on — backward references only, so the proposed set can never contain a
  // cycle. The client maps indices to created TicketIds on approval.
  dependsOn: Schema.optional(Schema.Array(NonNegativeInt)),
});
export type WorkflowTicketProposal = typeof WorkflowTicketProposal.Type;

export const WorkflowIntakeResult = Schema.Struct({
  proposals: Schema.Array(WorkflowTicketProposal),
});
export type WorkflowIntakeResult = typeof WorkflowIntakeResult.Type;

export const WorkflowIntakeBraindump = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
export type WorkflowIntakeBraindump = typeof WorkflowIntakeBraindump.Type;

// A scratch file from .t3/ticket/<id>/ in the ticket's worktree — the
// ticket's case file (PLAN.md, SPEC.md, REVIEW.md, ...).
export const WorkflowTicketArtifact = Schema.Struct({
  name: TrimmedNonEmptyString,
  content: Schema.String,
  truncated: Schema.optional(Schema.Boolean),
});
export type WorkflowTicketArtifact = typeof WorkflowTicketArtifact.Type;

export const WorkflowTicketArtifactsResult = Schema.Struct({
  artifacts: Schema.Array(WorkflowTicketArtifact),
});
export type WorkflowTicketArtifactsResult = typeof WorkflowTicketArtifactsResult.Type;

// Webhook ingress config for a board. The plaintext token appears ONLY in
// the response that created/rotated it; thereafter only the prefix.
export const WorkflowWebhookConfig = Schema.Struct({
  path: Schema.String,
  hasToken: Schema.Boolean,
  tokenPrefix: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
});
export type WorkflowWebhookConfig = typeof WorkflowWebhookConfig.Type;

// ── Per-board metrics dashboard ──────────────────────────────────────────────

export const BoardMetricsCycleTime = Schema.Struct({
  count: Schema.Number,
  p50Ms: Schema.Number,
  p90Ms: Schema.Number,
  avgMs: Schema.Number,
});
export type BoardMetricsCycleTime = typeof BoardMetricsCycleTime.Type;

export const BoardMetricsLaneWip = Schema.Struct({
  laneKey: Schema.String,
  admitted: Schema.Number,
  queued: Schema.Number,
});
export type BoardMetricsLaneWip = typeof BoardMetricsLaneWip.Type;

export const BoardMetricsOldest = Schema.Struct({
  ticketId: Schema.String,
  title: Schema.String,
  laneKey: Schema.NullOr(Schema.String),
  ageMs: Schema.Number,
});
export type BoardMetricsOldest = typeof BoardMetricsOldest.Type;

export const BoardMetricsRouteOutcome = Schema.Struct({
  fromLane: Schema.NullOr(Schema.String),
  toLane: Schema.NullOr(Schema.String),
  source: Schema.String,
  result: Schema.String,
  count: Schema.Number,
});
export type BoardMetricsRouteOutcome = typeof BoardMetricsRouteOutcome.Type;

export const BoardMetricsStep = Schema.Struct({
  laneKey: Schema.String,
  stepKey: Schema.String,
  stepType: Schema.String,
  succeeded: Schema.Number,
  failed: Schema.Number,
  retries: Schema.Number,
  totalTokens: Schema.Number,
  avgDurationMs: Schema.Number,
});
export type BoardMetricsStep = typeof BoardMetricsStep.Type;

export const WorkflowBoardMetrics = Schema.Struct({
  windowDays: Schema.Number,
  generatedAt: Schema.String,
  throughput: Schema.Struct({ created: Schema.Number, shipped: Schema.Number }),
  cycleTime: BoardMetricsCycleTime,
  wipByLane: Schema.Array(BoardMetricsLaneWip),
  statusBreakdown: Schema.Record(Schema.String, Schema.Number),
  attention: Schema.Struct({
    blocked: Schema.Number,
    waitingOnUser: Schema.Number,
    oldest: Schema.Array(BoardMetricsOldest),
  }),
  routeOutcomes: Schema.Array(BoardMetricsRouteOutcome),
  manualMoveCount: Schema.Number,
  stepStats: Schema.Array(BoardMetricsStep),
});
export type WorkflowBoardMetrics = typeof WorkflowBoardMetrics.Type;

// ─────────────────────────────────────────────────────────────────────────────

// What happened on a board in the last window — the "stand-up" summary.
export const WorkflowBoardDigest = Schema.Struct({
  windowHours: NonNegativeInt,
  createdCount: NonNegativeInt,
  shippedCount: NonNegativeInt,
  totalTokens: NonNegativeInt,
  totalDurationMs: NonNegativeInt,
  needsAttention: Schema.Array(
    Schema.Struct({
      ticketId: TicketId,
      title: Schema.String,
      status: Schema.String,
      laneKey: LaneKey,
      sinceMs: NonNegativeInt,
    }),
  ),
});
export type WorkflowBoardDigest = typeof WorkflowBoardDigest.Type;

// Simulated routing for a hypothetical ticket: which lanes it would visit
// under a uniform step-outcome scenario, and why each hop happened.
export const WorkflowDryRunScenario = Schema.Literals(["success", "failure", "blocked"]);
export type WorkflowDryRunScenario = typeof WorkflowDryRunScenario.Type;

export const WorkflowDryRunHop = Schema.Struct({
  fromLane: LaneKey,
  toLane: LaneKey,
  source: Schema.Literals(["step_on", "lane_transition", "lane_on"]),
  // Which pipeline step's on-route decided the hop (step_on only).
  viaStepKey: Schema.optional(StepKey),
  // Match the Schema.Int used by every other matchedTransitionIndex field
  // (TicketRouteDecided, WorkflowRouteDecisionView) rather than the narrower
  // NonNegativeInt, so the constraint is consistent across the conceptual field.
  matchedTransitionIndex: Schema.optional(Schema.Int),
  result: WorkflowDryRunScenario,
});
export type WorkflowDryRunHop = typeof WorkflowDryRunHop.Type;

export const WorkflowDryRunEnd = Schema.Literals([
  // The walk reached a terminal lane.
  "terminal",
  // The walk reached a manual lane — a human (action/move/event) continues it.
  "manual",
  // The pipeline finished but nothing routed; the ticket would sit in the lane.
  "no_route",
  // The walk kept cycling and hit the hop cap — likely an unbounded loop.
  "cycle_cap",
]);
export type WorkflowDryRunEnd = typeof WorkflowDryRunEnd.Type;

export const WorkflowDryRunResult = Schema.Struct({
  startLane: LaneKey,
  scenario: WorkflowDryRunScenario,
  hops: Schema.Array(WorkflowDryRunHop),
  end: WorkflowDryRunEnd,
  endLane: LaneKey,
  // Transitions whose predicates referenced data a dry run cannot know
  // (captured outputs, ticket fields) — evaluated against an empty context.
  notes: Schema.Array(Schema.String),
});
export type WorkflowDryRunResult = typeof WorkflowDryRunResult.Type;

export const WorkflowTicketDetailView = Schema.Struct({
  ticket: BoardTicketView,
  steps: Schema.Array(WorkflowStepRunView),
  messages: Schema.Array(WorkflowTicketMessageView),
  routeHistory: Schema.optional(Schema.Array(WorkflowRouteDecisionView)),
  syncedSource: Schema.optional(
    Schema.Struct({
      provider: WorkSourceProviderName,
      url: TrimmedNonEmptyString,
      assignees: Schema.optional(Schema.Array(Schema.String)),
      labels: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
export type WorkflowTicketDetailView = typeof WorkflowTicketDetailView.Type;

// ---------------------------------------------------------------------------
// Self-improve: board proposal schemas
// ---------------------------------------------------------------------------

export const WorkflowProposalStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "invalid",
  "reverted",
]);
export type WorkflowProposalStatus = typeof WorkflowProposalStatus.Type;

export const WorkflowProposalValidation = Schema.Struct({
  preservationOk: Schema.Boolean,
  lintOk: Schema.Boolean,
  dryRunOk: Schema.Boolean,
  laneDiffCount: Schema.Number,
  lintErrors: Schema.Array(WorkflowLintError),
  dryRunRegressions: Schema.Array(Schema.String),
  messages: Schema.Array(Schema.String),
});
export type WorkflowProposalValidation = typeof WorkflowProposalValidation.Type;

export const WorkflowBoardProposalView = Schema.Struct({
  proposalId: Schema.String,
  boardId: BoardId,
  status: WorkflowProposalStatus,
  rationale: Schema.String,
  validation: WorkflowProposalValidation,
  baseVersionHash: Schema.String,
  appliedVersionHash: Schema.NullOr(Schema.String),
  outdated: Schema.Boolean,
  agent: AgentSelection,
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type WorkflowBoardProposalView = typeof WorkflowBoardProposalView.Type;

// RPC input shapes

export const WorkflowProposeBoardImprovementInput = Schema.Struct({
  boardId: BoardId,
  agent: AgentSelection,
});
export type WorkflowProposeBoardImprovementInput = typeof WorkflowProposeBoardImprovementInput.Type;

export const WorkflowListBoardProposalsInput = Schema.Struct({ boardId: BoardId });
export type WorkflowListBoardProposalsInput = typeof WorkflowListBoardProposalsInput.Type;

export const WorkflowGetBoardProposalInput = Schema.Struct({ proposalId: Schema.String });
export type WorkflowGetBoardProposalInput = typeof WorkflowGetBoardProposalInput.Type;

export const WorkflowResolveBoardProposalInput = Schema.Struct({
  proposalId: Schema.String,
  action: Schema.Literals(["approve", "reject"]),
});
export type WorkflowResolveBoardProposalInput = typeof WorkflowResolveBoardProposalInput.Type;

export const WorkflowRevertBoardProposalInput = Schema.Struct({ proposalId: Schema.String });
export type WorkflowRevertBoardProposalInput = typeof WorkflowRevertBoardProposalInput.Type;

// RPC result shapes

export const WorkflowProposeBoardImprovementResult = Schema.Struct({
  proposal: WorkflowBoardProposalView,
});
export type WorkflowProposeBoardImprovementResult =
  typeof WorkflowProposeBoardImprovementResult.Type;

export const WorkflowListBoardProposalsResult = Schema.Struct({
  proposals: Schema.Array(WorkflowBoardProposalView),
});
export type WorkflowListBoardProposalsResult = typeof WorkflowListBoardProposalsResult.Type;

export const WorkflowGetBoardProposalResult = Schema.Struct({
  proposal: WorkflowBoardProposalView,
  proposedDefinition: WorkflowDefinitionEncoded,
  baseDefinition: WorkflowDefinitionEncoded,
});
export type WorkflowGetBoardProposalResult = typeof WorkflowGetBoardProposalResult.Type;

export const WorkflowResolveBoardProposalResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), proposal: WorkflowBoardProposalView }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(["conflict", "live_tickets", "lint", "invalid"]),
    message: Schema.String,
    lintErrors: Schema.optional(Schema.Array(WorkflowLintError)),
  }),
]);
export type WorkflowResolveBoardProposalResult = typeof WorkflowResolveBoardProposalResult.Type;

export const WorkflowRevertBoardProposalResult = WorkflowResolveBoardProposalResult;
export type WorkflowRevertBoardProposalResult = typeof WorkflowRevertBoardProposalResult.Type;

// ── Create-workflow wizard ─────────────────────────────────────────────────

export const BoardTemplateSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  requiresAgent: Schema.Boolean,
});
export type BoardTemplateSummary = typeof BoardTemplateSummary.Type;

export const WorkflowCreateChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({
    kind: Schema.Literal("template"),
    templateId: Schema.String,
    agent: Schema.optional(AgentSelection),
  }),
  Schema.Struct({ kind: Schema.Literal("definition"), definition: WorkflowDefinitionEncoded }),
]);
export type WorkflowCreateChoice = typeof WorkflowCreateChoice.Type;

export const WorkflowCreateWorkflowBoardInput = Schema.Struct({
  projectId: ProjectId,
  name: WorkflowBoardName,
  choice: WorkflowCreateChoice,
});
export type WorkflowCreateWorkflowBoardInput = typeof WorkflowCreateWorkflowBoardInput.Type;

export const WorkflowCreateWorkflowBoardResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), boardId: BoardId }),
  Schema.Struct({
    ok: Schema.Literal(false),
    lintErrors: Schema.Array(WorkflowLintError),
    message: Schema.optional(Schema.String),
  }),
]);
export type WorkflowCreateWorkflowBoardResult = typeof WorkflowCreateWorkflowBoardResult.Type;

export const WorkflowGenerateWorkflowDraftInput = Schema.Struct({
  projectId: ProjectId,
  name: WorkflowBoardName,
  // A generous "how you work" description cap — bounds the free text sent to
  // the LLM so a runaway client payload can't drive unbounded token cost.
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  agent: AgentSelection,
});
export type WorkflowGenerateWorkflowDraftInput = typeof WorkflowGenerateWorkflowDraftInput.Type;

export const WorkflowGenerateWorkflowDraftResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    definition: WorkflowDefinitionEncoded,
    rationale: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    lintErrors: Schema.optional(Schema.Array(WorkflowLintError)),
    message: Schema.String,
  }),
]);
export type WorkflowGenerateWorkflowDraftResult = typeof WorkflowGenerateWorkflowDraftResult.Type;

export const WorkflowListBoardTemplatesResult = Schema.Struct({
  templates: Schema.Array(BoardTemplateSummary),
});
export type WorkflowListBoardTemplatesResult = typeof WorkflowListBoardTemplatesResult.Type;

export class WorkflowRpcError extends Schema.TaggedErrorClass<WorkflowRpcError>()(
  "WorkflowRpcError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
