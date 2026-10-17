import {
  CivilizationCitizenSummary,
  CivilizationContextResponse,
  CivilizationInboxListRequest,
  CivilizationInboxPage,
  CivilizationMailAcknowledgeRequest,
  CivilizationMailAcknowledgeResult,
  CivilizationMailReceiveRequest,
  CivilizationMailReceiveResult,
  CivilizationMailSendRequest,
  CivilizationMailSendResult,
  CivilizationNoteBody,
  CivilizationNoteCreateRequest,
  CivilizationNoteId,
  CivilizationNoteResolveRequest,
  CivilizationNoteSummary,
  CivilizationNoteSourceReference,
  CivilizationNoteUpdateRequest,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CivilizationContext from "../../../civilization/ContextService.ts";
import * as CivilizationKnowledge from "../../../civilization/KnowledgeService.ts";
import * as CivilizationMail from "../../../civilization/MailService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CivilizationKnowledge.CivilizationKnowledgeService,
  CivilizationContext.CivilizationContextService,
  CivilizationMail.CivilizationMailService,
];

const readFailure = OrchestratorMcpFailure;

// KnowledgeService cursors are opaque, versioned strings. Keep that opacity at
// the MCP boundary instead of exposing the internal cursor payload schema.
const CivilizationCensusToolPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  citizens: Schema.Array(CivilizationCitizenSummary),
  nextCursor: Schema.NullOr(Schema.String),
  partial: Schema.Boolean,
});

const CivilizationNotesToolPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  notes: Schema.Array(CivilizationNoteSummary),
  nextCursor: Schema.NullOr(Schema.String),
  partial: Schema.Boolean,
});

const CivilizationContextTool = Tool.make("civilization_context", {
  description:
    "Read the current Civilization context/capability view for a project. Omit projectId to use this thread's project. This is metadata/context only and does not mutate notes or inbox state.",
  parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  success: CivilizationContextResponse,
  failure: readFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read Civilization context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CivilizationCensusTool = Tool.make("civilization_census", {
  description:
    "List Civilization citizens in stable keyset order. Omit projectId to use this thread's project. Pass the returned cursor to continue the same revision; stale cursors fail explicitly.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: CivilizationCensusToolPage,
  failure: readFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Civilization citizens")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CivilizationNoteListTool = Tool.make("civilization_note_list", {
  description:
    "List Civilization note metadata without releasing note bodies. Omit projectId to use this thread's project. Pass the returned cursor to continue the same notes revision.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    includeResolved: Schema.optional(Schema.Boolean),
    selection: Schema.optional(Schema.Literals(["recent", "stable_id"])),
  }),
  success: CivilizationNotesToolPage,
  failure: readFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Civilization notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CivilizationNoteReadTool = Tool.make("civilization_note_read", {
  description:
    "Read one Civilization note body after the service rechecks project access and the caller's transfer ceiling. Omit projectId to use this thread's project.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    noteId: CivilizationNoteId,
  }),
  success: CivilizationNoteBody,
  failure: readFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a Civilization note")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CivilizationInboxListTool = Tool.make("civilization_inbox_list", {
  description:
    "List this calling Civilization citizen's inbox metadata without releasing message bodies or changing offer/acknowledgement state. Authority, project, lifecycle epochs, run, provider, and permission ceilings come from the authenticated caller.",
  parameters: Schema.Struct({
    cursor: Schema.optional(CivilizationInboxListRequest.fields.cursor),
    limit: Schema.optional(CivilizationInboxListRequest.fields.limit),
    includeAcknowledged: Schema.optional(CivilizationInboxListRequest.fields.includeAcknowledged),
  }),
  success: CivilizationInboxPage,
  failure: readFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Civilization inbox")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CivilizationNoteCreateTool = Tool.make("civilization_note_create", {
  description:
    "Create a Civilization note as the currently running T3 citizen. Author identity, project, epoch, run, and permission ceilings come from the authenticated caller and cannot be overridden.",
  parameters: Schema.Struct({
    clientRequestId: Schema.String,
    category: CivilizationNoteCreateRequest.fields.category,
    body: CivilizationNoteCreateRequest.fields.body,
    sourceReferences: Schema.optional(Schema.Array(CivilizationNoteSourceReference)),
  }),
  success: CivilizationNoteBody,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a Civilization note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const CivilizationNoteUpdateTool = Tool.make("civilization_note_update", {
  description:
    "Update an existing Civilization note as the currently running T3 citizen. Uses expectedRevision for concurrency; caller identity/project/modes are authoritative and cannot be overridden.",
  parameters: Schema.Struct({
    noteId: CivilizationNoteId,
    expectedRevision: CivilizationNoteUpdateRequest.fields.expectedRevision,
    category: CivilizationNoteUpdateRequest.fields.category,
    body: CivilizationNoteUpdateRequest.fields.body,
    sourceReferences: CivilizationNoteUpdateRequest.fields.sourceReferences,
  }),
  success: CivilizationNoteBody,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a Civilization note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const CivilizationNoteResolveTool = Tool.make("civilization_note_resolve", {
  description:
    "Resolve or reopen an existing Civilization note as the currently running T3 citizen. Uses expectedRevision for concurrency; caller identity/project/modes are authoritative and cannot be overridden.",
  parameters: Schema.Struct({
    noteId: CivilizationNoteId,
    expectedRevision: CivilizationNoteResolveRequest.fields.expectedRevision,
    resolved: CivilizationNoteResolveRequest.fields.resolved,
  }),
  success: CivilizationNoteBody,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Resolve a Civilization note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const CivilizationMailSendTool = Tool.make("civilization_mail_send", {
  description:
    "Send one Civilization mail message as the currently running citizen. Sender/project/run/epochs/provider/modes are authoritative server state and cannot be overridden.",
  parameters: Schema.Struct({
    targetThreadId: CivilizationMailSendRequest.fields.targetThreadId,
    clientRequestId: CivilizationMailSendRequest.fields.clientRequestId,
    body: CivilizationMailSendRequest.fields.body,
    replyToMessageId: Schema.optional(CivilizationMailSendRequest.fields.replyToMessageId),
  }),
  success: CivilizationMailSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send Civilization mail")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const CivilizationMailReceiveTool = Tool.make("civilization_mail_receive", {
  description:
    "Offer one addressed Civilization mail body to the currently running citizen. This records the body offer for idempotency/audit but does not acknowledge the message.",
  parameters: Schema.Struct({
    messageId: CivilizationMailReceiveRequest.fields.messageId,
    clientRequestId: CivilizationMailReceiveRequest.fields.clientRequestId,
  }),
  success: CivilizationMailReceiveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Receive Civilization mail")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const CivilizationMailAcknowledgeTool = Tool.make("civilization_mail_acknowledge", {
  description:
    "Acknowledge one previously offered Civilization mail message as the currently running citizen. Recipient/project/run/epochs/provider/modes are derived from authenticated server state.",
  parameters: Schema.Struct({
    messageId: CivilizationMailAcknowledgeRequest.fields.messageId,
    clientRequestId: CivilizationMailAcknowledgeRequest.fields.clientRequestId,
  }),
  success: CivilizationMailAcknowledgeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Acknowledge Civilization mail")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const CivilizationToolkit = Toolkit.make(
  CivilizationContextTool,
  CivilizationCensusTool,
  CivilizationNoteListTool,
  CivilizationNoteReadTool,
  CivilizationInboxListTool,
  CivilizationNoteCreateTool,
  CivilizationNoteUpdateTool,
  CivilizationNoteResolveTool,
  CivilizationMailSendTool,
  CivilizationMailReceiveTool,
  CivilizationMailAcknowledgeTool,
);
