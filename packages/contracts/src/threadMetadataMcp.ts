import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";

function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const ThreadMetadataTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "New concise display title. Required only when action is rename.",
});

const ThreadMetadataClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

const ThreadMetadataMcpPullRequestUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) =>
    isHttpUrl(value) ? true : "Pull request URL must be a well-formed HTTP(S) URL.",
  ),
).annotate({
  description: "Canonical HTTP(S) pull request URL, including self-hosted repository URLs.",
});

export const ThreadMetadataMcpAction = Schema.Literals([
  "rename",
  "regenerate_title",
  "link_pull_request",
  "unlink_pull_request",
  "move_project",
]).annotate({
  description:
    "Metadata mutation: rename, regenerate_title, link_pull_request, unlink_pull_request, or move_project.",
});
export type ThreadMetadataMcpAction = typeof ThreadMetadataMcpAction.Type;

export const ThreadMetadataMcpPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString.annotate({
    description: "Repository name as owner/name.",
  }),
  number: PositiveInt.annotate({ description: "Pull request number." }),
  url: ThreadMetadataMcpPullRequestUrl,
});
export type ThreadMetadataMcpPullRequest = typeof ThreadMetadataMcpPullRequest.Type;

export const ThreadMetadataMcpUpdateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({
    description: "Thread to update. Omit to update the calling thread.",
  }),
  action: ThreadMetadataMcpAction,
  title: Schema.optional(ThreadMetadataTitle),
  pullRequest: Schema.optional(ThreadMetadataMcpPullRequest).annotate({
    description: "Pull request to link. Required only when action is link_pull_request.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description: "Destination project. Required only when action is move_project.",
  }),
  keepWorktree: Schema.optional(Schema.Boolean).annotate({
    description:
      "With move_project, move a thread that has a worktree and leave that checkout in place. The next turn still runs there.",
  }),
  clientRequestId: Schema.optional(ThreadMetadataClientRequestId),
}).check(
  Schema.makeFilter((input) => {
    const extras =
      input.projectId !== undefined || input.keepWorktree !== undefined
        ? "projectId and keepWorktree are only valid for move_project."
        : true;
    switch (input.action) {
      case "rename":
        return input.title !== undefined && input.pullRequest === undefined && extras === true
          ? true
          : "rename requires title and does not accept pullRequest, projectId, or keepWorktree.";
      case "link_pull_request":
        return input.pullRequest !== undefined && input.title === undefined && extras === true
          ? true
          : "link_pull_request requires pullRequest and does not accept title, projectId, or keepWorktree.";
      case "regenerate_title":
      case "unlink_pull_request":
        return input.title === undefined && input.pullRequest === undefined && extras === true
          ? true
          : `${input.action} does not accept title, pullRequest, projectId, or keepWorktree.`;
      case "move_project":
        return input.projectId !== undefined &&
          input.title === undefined &&
          input.pullRequest === undefined
          ? true
          : "move_project requires projectId and does not accept title or pullRequest.";
    }
  }),
);
export type ThreadMetadataMcpUpdateInput = typeof ThreadMetadataMcpUpdateInput.Type;

export const ThreadMetadataMcpUpdateResult = Schema.Struct({
  threadId: ThreadId,
  action: ThreadMetadataMcpAction,
  commandId: CommandId,
  sequence: NonNegativeInt,
  title: Schema.String,
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  projectId: Schema.optional(ProjectId),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: IsoDateTime,
});
export type ThreadMetadataMcpUpdateResult = typeof ThreadMetadataMcpUpdateResult.Type;
