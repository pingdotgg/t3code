import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  THREAD_DOCUMENT_COMMENT_MAX_BODY_LENGTH,
  ThreadDocumentCommentId,
  ThreadDocumentCommentStatus,
  TrimmedNonEmptyString,
} from "@lathe/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as DocumentComments from "../../../fork/DocumentComments.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  // The access gate reads the calling thread through it.
  ThreadManagementService.ThreadManagementService,
  DocumentComments.DocumentComments,
];

export const ListDocumentCommentsInput = Schema.Struct({
  filePath: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Only comments on this workspace-relative file path.",
    }),
  ),
  status: Schema.optional(
    ThreadDocumentCommentStatus.annotate({
      description: "Only open or only resolved comments. Omit for both.",
    }),
  ),
});
export type ListDocumentCommentsInput = typeof ListDocumentCommentsInput.Type;

export const ResolveDocumentCommentInput = Schema.Struct({
  commentId: ThreadDocumentCommentId.annotate({
    description: "The document comment id, as named in the review comment's section.",
  }),
  resolution: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(THREAD_DOCUMENT_COMMENT_MAX_BODY_LENGTH),
    ).annotate({
      description: "One short sentence on what you changed to address the comment.",
    }),
  ),
});
export type ResolveDocumentCommentInput = typeof ResolveDocumentCommentInput.Type;

export class DocumentCommentThreadNotFoundError extends Schema.TaggedError<DocumentCommentThreadNotFoundError>()(
  "DocumentCommentThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class DocumentCommentNotFoundError extends Schema.TaggedError<DocumentCommentNotFoundError>()(
  "DocumentCommentNotFoundError",
  { commentId: Schema.String },
) {
  override get message(): string {
    return `Document comment ${this.commentId} does not exist on this thread. Use list_document_comments to see its comments.`;
  }
}

export class DocumentCommentListFailedError extends Schema.TaggedError<DocumentCommentListFailedError>()(
  "DocumentCommentListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the document comments.";
  }
}

export class DocumentCommentResolveFailedError extends Schema.TaggedError<DocumentCommentResolveFailedError>()(
  "DocumentCommentResolveFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not resolve the document comment.";
  }
}

export const DocumentCommentToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  DocumentCommentThreadNotFoundError,
  DocumentCommentNotFoundError,
  DocumentCommentListFailedError,
  DocumentCommentResolveFailedError,
]);
export type DocumentCommentToolError = typeof DocumentCommentToolError.Type;

export const DocumentCommentEntry = Schema.Struct({
  id: Schema.String,
  filePath: Schema.String,
  startLine: Schema.Int.annotate({ description: "1-based source line where the quote starts." }),
  endLine: Schema.Int,
  quote: Schema.String.annotate({ description: "The passage the user commented on." }),
  body: Schema.String,
  status: ThreadDocumentCommentStatus,
  resolution: Schema.NullOr(Schema.String),
});
export type DocumentCommentEntry = typeof DocumentCommentEntry.Type;

export const ListDocumentCommentsResult = Schema.Struct({
  comments: Schema.Array(DocumentCommentEntry),
});
export type ListDocumentCommentsResult = typeof ListDocumentCommentsResult.Type;

export const ResolveDocumentCommentResult = Schema.Struct({
  commentId: Schema.String,
  resolved: Schema.Literal(true),
  alreadyResolved: Schema.Boolean.annotate({
    description: "True when the comment was resolved before the call.",
  }),
});
export type ResolveDocumentCommentResult = typeof ResolveDocumentCommentResult.Type;

const ListDocumentCommentsTool = Tool.make("list_document_comments", {
  description:
    "List the comments the user left on workspace documents in this thread, oldest first, with the quoted passage and its source lines. Filter by file path or status.",
  parameters: ListDocumentCommentsInput,
  success: ListDocumentCommentsResult,
  failure: DocumentCommentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List document comments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Acts on the calling thread, which an outside client does not have.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ResolveDocumentCommentTool = Tool.make("resolve_document_comment", {
  description:
    "Mark a document comment resolved once you have addressed it, with one short sentence on what changed. Resolving an already resolved comment succeeds with alreadyResolved=true.",
  parameters: ResolveDocumentCommentInput,
  success: ResolveDocumentCommentResult,
  failure: DocumentCommentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resolve document comment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Acts on the calling thread, which an outside client does not have.
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const DocumentCommentsToolkit = Toolkit.make(
  ListDocumentCommentsTool,
  ResolveDocumentCommentTool,
);
