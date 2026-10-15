import {
  IssueCapabilities,
  IssueListState,
  IssueOperationError,
  IssueState,
  IssueTrackerKind,
  IssueUnavailableError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  ThreadIssueLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as IssueService from "../../../issue/IssueService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadIssueService from "../../../orchestration-v2/ThreadIssueService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
  IssueService.IssueService,
  ThreadIssueService.ThreadIssueService,
];

/**
 * Either the issue's URL, or its key within a project's tracker. A key alone is read through the
 * project named, or the caller's own thread's project; a URL is read through whichever project
 * here is a checkout of that repository, read-only when none is.
 */
export const IssueTargetInput = Schema.Struct({
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The issue's web URL, for example https://github.com/owner/repo/issues/123. Preferred when you have it.",
    }),
  ),
  key: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The issue's key within the project's tracker: the number on a git host. Required when url is omitted.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project whose tracker holds the issue. Defaults to this thread's project when key is used.",
    }),
  ),
});
export type IssueTargetInput = typeof IssueTargetInput.Type;

const ThreadTargetInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Thread to act on. Omit for this thread." }),
  ),
});

export class IssueTargetIncompleteError extends Schema.TaggedError<IssueTargetIncompleteError>()(
  "IssueTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or key (with projectId when not running inside a T3 thread).";
  }
}

export class IssueProjectRequiredError extends Schema.TaggedError<IssueProjectRequiredError>()(
  "IssueProjectRequiredError",
  {},
) {
  override get message(): string {
    return "Pass projectId: this MCP client is not running inside a T3 thread.";
  }
}

export class IssueThreadRequiredError extends Schema.TaggedError<IssueThreadRequiredError>()(
  "IssueThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class IssueThreadNotFoundError extends Schema.TaggedError<IssueThreadNotFoundError>()(
  "IssueThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class IssueProjectNotFoundError extends Schema.TaggedError<IssueProjectNotFoundError>()(
  "IssueProjectNotFoundError",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found or has no issue tracker.`;
  }
}

export class IssueLinkFailedError extends Schema.TaggedError<IssueLinkFailedError>()(
  "IssueLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change the issue link.";
  }
}

export const IssueToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  IssueUnavailableError,
  IssueOperationError,
  IssueTargetIncompleteError,
  IssueProjectRequiredError,
  IssueThreadRequiredError,
  IssueThreadNotFoundError,
  IssueProjectNotFoundError,
  IssueLinkFailedError,
]);
export type IssueToolError = typeof IssueToolError.Type;

/** How a tool names an issue back: enough to pass to any other issue tool. */
const IssueIdentity = {
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  host: Schema.String,
  scope: Schema.String,
  key: Schema.String,
  url: Schema.String,
};

export const IssueEntry = Schema.Struct({
  ...IssueIdentity,
  displayKey: Schema.String,
  title: Schema.String,
  state: IssueState,
  author: Schema.NullOr(Schema.String),
  assignees: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  commentCount: Schema.Int,
});
export type IssueEntry = typeof IssueEntry.Type;

export const ListIssuesResult = Schema.Struct({
  issues: Schema.Array(IssueEntry),
  /** Pass back as `cursors` to read the next slice of each scope that has one. */
  nextCursors: Schema.Record(Schema.String, Schema.String),
  errors: Schema.Array(Schema.Struct({ projectId: ProjectId, message: Schema.String })),
});
export type ListIssuesResult = typeof ListIssuesResult.Type;

export const ReadIssueResult = Schema.Struct({
  ...IssueIdentity,
  displayKey: Schema.String,
  title: Schema.String,
  state: IssueState,
  /** False for an issue outside every project's own scope: it can be read, not changed. */
  writable: Schema.Boolean,
  capabilities: IssueCapabilities,
  author: Schema.NullOr(Schema.String),
  assignees: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      author: Schema.NullOr(Schema.String),
      body: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  /** Older comments exist beyond the page returned. */
  commentsTruncated: Schema.Boolean,
  linkedPullRequests: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      state: Schema.String,
      closesIssue: Schema.Boolean,
    }),
  ),
});
export type ReadIssueResult = typeof ReadIssueResult.Type;

export const CreateIssueResult = Schema.Struct({
  ...IssueIdentity,
  displayKey: Schema.String,
});
export type CreateIssueResult = typeof CreateIssueResult.Type;

export const IssueWriteResult = Schema.Struct({ ...IssueIdentity });

export const ThreadIssueEntry = Schema.Struct({
  ...IssueIdentity,
  source: ThreadIssueLinkSource,
  /** Null until the server has read the issue once. */
  displayKey: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  state: Schema.NullOr(IssueState),
});
export type ThreadIssueEntry = typeof ThreadIssueEntry.Type;

export const LinkIssueResult = Schema.Struct({
  ...IssueIdentity,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the issue was linked to this thread before the call.",
  }),
});
export type LinkIssueResult = typeof LinkIssueResult.Type;

export const UnlinkIssueResult = Schema.Struct({
  ...IssueIdentity,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the issue was not linked to this thread to begin with.",
  }),
});
export type UnlinkIssueResult = typeof UnlinkIssueResult.Type;

export const ListThreadIssuesResult = Schema.Struct({
  issues: Schema.Array(ThreadIssueEntry),
});
export type ListThreadIssuesResult = typeof ListThreadIssuesResult.Type;

const LINK_EVERY_ISSUE =
  "Link every issue you are asked to work on, or file, to this thread with link_issue.";

const ListIssuesTool = Tool.make("list_issues", {
  description:
    "List issues in a project's tracker, newest updated first. Omit projectId for this thread's project. Pass the returned nextCursors back as cursors for the next slice.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Project to list. Omit for this thread's project." }),
    ),
    state: Schema.optional(IssueListState.annotate({ description: "Defaults to open." })),
    query: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
        description: "Free text the tracker matches itself.",
      }),
    ),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    cursors: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  success: ListIssuesResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ReadIssueTool = Tool.make("read_issue", {
  description:
    "Read an issue: its body, state, labels, assignees, the newest page of comments, and the pull requests the tracker links to it. Pass the URL, or key with projectId. A URL from a repository no project here is a checkout of is read through any project on that host, read-only.",
  parameters: IssueTargetInput,
  success: ReadIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CreateIssueTool = Tool.make("create_issue", {
  description: `File an issue in a project's tracker. Omit projectId for this thread's project. ${LINK_EVERY_ISSUE}`,
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Project to file in. Omit for this thread's project." }),
    ),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    body: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))),
    labels: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50))),
    assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25))),
  }),
  success: CreateIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const CommentOnIssueTool = Tool.make("comment_on_issue", {
  description:
    "Post a comment on an issue. Pass the URL, or key with projectId. Fails on an issue outside every project's own repository.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    body: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  }),
  success: IssueWriteResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Comment on issue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SetIssueStateTool = Tool.make("set_issue_state", {
  description:
    "Move an issue to one of the states its tracker offers (read_issue reports them under capabilities.states): open or closed on a git host, with a closeReason where the tracker takes one.",
  parameters: Schema.Struct({
    ...IssueTargetInput.fields,
    state: TrimmedNonEmptyString.annotate({
      description: "A state name from capabilities.states.",
    }),
    closeReason: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A reason from capabilities.closeReasons, for a closing state only.",
      }),
    ),
  }),
  success: IssueWriteResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set issue state")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const LinkIssueTool = Tool.make("link_issue", {
  description: `${LINK_EVERY_ISSUE} Links an issue to a thread so T3 Code shows it beside the thread with its current state. Pass the URL, or key with projectId. Linking an already-linked issue succeeds with alreadyLinked=true.`,
  parameters: Schema.Struct({ ...IssueTargetInput.fields, ...ThreadTargetInput.fields }),
  success: LinkIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link issue to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkIssueTool = Tool.make("unlink_issue", {
  description:
    "Remove an issue link from a thread. The issue itself is not changed. Unlinking an issue that is not linked succeeds with wasLinked=false.",
  parameters: Schema.Struct({ ...IssueTargetInput.fields, ...ThreadTargetInput.fields }),
  success: UnlinkIssueResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink issue from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  description: `List the issues linked to a thread (omit threadId for this thread) with their last known tracker state. ${LINK_EVERY_ISSUE}`,
  parameters: ThreadTargetInput,
  success: ListThreadIssuesResult,
  failure: IssueToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const IssuesToolkit = Toolkit.make(
  ListIssuesTool,
  ReadIssueTool,
  CreateIssueTool,
  CommentOnIssueTool,
  SetIssueStateTool,
  LinkIssueTool,
  UnlinkIssueTool,
  ListThreadIssuesTool,
);
