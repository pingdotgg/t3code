import {
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  PullRequestCheck,
  PullRequestCommentKind,
  PullRequestChecksState,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeability,
  PullRequestMergeMethod,
  PullRequestReviewVerdict,
  PullRequestReviewDecision,
  PullRequestReviewGuide,
  PullRequestReviewGuideRun,
  PullRequestState,
  PullRequestUnavailableError,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as GitManager from "../../../git/GitManager.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestWatchService from "../../../pullRequest/PullRequestWatchService.ts";
import {
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
} from "../../../pullRequest/pullRequestTarget.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const forgeDependencies = [...dependencies, PullRequestService.PullRequestService];

const guideDependencies = [
  ...dependencies,
  PullRequestReviewGuideService.PullRequestReviewGuideService,
];

const watchDependencies = [...dependencies, PullRequestWatchService.PullRequestWatchService];

export const PullRequestTargetInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread. Default: this thread.",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "With `number`, when no `url`.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "With `repository`, when no `url`.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: this project's host.",
    }),
  ),
});
export type PullRequestTargetInput = typeof PullRequestTargetInput.Type;

export class PullRequestThreadRequiredError extends Schema.TaggedError<PullRequestThreadRequiredError>()(
  "PullRequestThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class PullRequestLinkFailedError extends Schema.TaggedError<PullRequestLinkFailedError>()(
  "PullRequestLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedError<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export class PullRequestProjectNotFoundError extends Schema.TaggedError<PullRequestProjectNotFoundError>()(
  "PullRequestProjectNotFoundError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `No project in this environment is a checkout of ${this.repository}, so its pull requests cannot be read here. Add one with t3_project_create.`;
  }
}

export class PullRequestGuideFailedError extends Schema.TaggedError<PullRequestGuideFailedError>()(
  "PullRequestGuideFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PullRequestForgeError extends Schema.TaggedError<PullRequestForgeError>()(
  "PullRequestForgeError",
  { detail: Schema.optional(Schema.String), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail ?? "Could not read this thread's project.";
  }
}

export class PullRequestBranchHasNoneError extends Schema.TaggedError<PullRequestBranchHasNoneError>()(
  "PullRequestBranchHasNoneError",
  {},
) {
  override get message(): string {
    return "This thread's branch has no known PR. Pass number, or open one with pull_request_create.";
  }
}

export class PullRequestCursorInvalidError extends Schema.TaggedError<PullRequestCursorInvalidError>()(
  "PullRequestCursorInvalidError",
  {},
) {
  override get message(): string {
    return "This cursor is not from this tool. Pass a nextCursor from its last result.";
  }
}

export class PullRequestNothingToDoError extends Schema.TaggedError<PullRequestNothingToDoError>()(
  "PullRequestNothingToDoError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const PullRequestToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
  PullRequestThreadRequiredError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchService.PullRequestWatchFailedError,
  PullRequestUnavailableError,
  PullRequestWatchService.PullRequestNotOpenError,
  PullRequestWatchService.PullRequestWatchFromSubagentError,
  PullRequestProjectNotFoundError,
  PullRequestGuideFailedError,
  PullRequestForgeError,
  PullRequestBranchHasNoneError,
  PullRequestNothingToDoError,
  PullRequestCursorInvalidError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

/** A delegated child's report is how its parent learns the PR, so the link result asks for it. */
export const CHILD_PULL_REQUEST_REPORT_NEXT =
  "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.";

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean,
  next: Schema.optional(Schema.String),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

const PullRequestNumbersByRepository = Schema.Array(
  Schema.Struct({
    host: Schema.String,
    repository: Schema.String,
    numbers: Schema.Array(Schema.Int),
  }),
);

export const LinkPullRequestsResult = Schema.Struct({
  linked: PullRequestNumbersByRepository,
  alreadyLinked: PullRequestNumbersByRepository,
  linkedCount: Schema.Int,
  invalidUrls: Schema.optional(Schema.Array(Schema.String)),
  next: Schema.optional(Schema.String),
});
export type LinkPullRequestsResult = typeof LinkPullRequestsResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean,
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const UnlinkPullRequestsResult = Schema.Struct({
  unlinked: Schema.Array(
    Schema.Struct({
      host: Schema.String,
      repository: Schema.String,
      state: PullRequestState,
      numbers: Schema.Array(Schema.Int),
    }),
  ),
  unlinkedCount: Schema.Int,
  remaining: Schema.Int,
});
export type UnlinkPullRequestsResult = typeof UnlinkPullRequestsResult.Type;

export const WatchPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  watching: Schema.Boolean,
  wasWatching: Schema.Boolean,
});
export type WatchPullRequestResult = typeof WatchPullRequestResult.Type;

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
  watching: Schema.Boolean,
  state: Schema.NullOr(PullRequestState),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
  stack: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** 1-based layer from the bottom; siblings share a layer. */
      position: Schema.Int,
      size: Schema.Int,
    }),
  ),
});
export type ThreadPullRequestEntry = typeof ThreadPullRequestEntry.Type;

export const ListThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestEntry),
  chains: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** Bottom to top; each pull request comes before the ones built on it. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;

const LinkPullRequestTool = Tool.make("link_pull_request", {
  description:
    "Link a PR to this thread. T3 shows its status and settles the thread on merge. For several PRs, use `link_pull_requests`.",
  parameters: PullRequestTargetInput,
  success: LinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link pull request to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LinkPullRequestsTool = Tool.make("link_pull_requests", {
  description:
    "Link several PRs to a thread in one call. Use it instead of one `link_pull_request` per PR. URLs that are not PRs come back in `invalidUrls`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
    urls: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  }),
  success: LinkPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link pull requests to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Remove a PR link from this thread. Succeeds with `wasLinked=false` when it was not linked.",
  parameters: PullRequestTargetInput,
  success: UnlinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull request from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkPullRequestsTool = Tool.make("unlink_pull_requests", {
  description:
    "Unlink every PR on a thread whose last known state (as `list_thread_pull_requests` shows) is in `states`, in one call. Use it instead of one `unlink_pull_request` per PR. PRs with no known state stay linked.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
    states: Schema.Array(PullRequestState).check(Schema.isMinLength(1)),
  }),
  success: UnlinkPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink pull requests by state")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description:
    "List PRs linked to a thread, with last known state and stack order (bottom to top). Call only when you need that list. Never as an end-of-work check.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
  }),
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WatchPullRequestTool = Tool.make("watch_pull_request", {
  description:
    "Watch an open PR for this thread, linking it first if needed. T3 wakes you on failed checks, passed required checks, new comments or reviews, or conflicts. Handle old comments first. Only later ones wake you. After this call, end your turn. The watch stays on after each wake, so do not call this again on a wake. A wake is not a merge decision. Check readiness yourself.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies: watchDependencies,
})
  .annotate(Tool.Title, "Watch pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const UnwatchPullRequestTool = Tool.make("unwatch_pull_request", {
  description: "Stop watching a PR for this thread. It stays linked.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies: watchDependencies,
})
  .annotate(Tool.Title, "Stop watching pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const GuideTarget = Schema.Struct({
  url: PullRequestTargetInput.fields.url,
  repository: PullRequestTargetInput.fields.repository,
  number: PullRequestTargetInput.fields.number,
  host: PullRequestTargetInput.fields.host,
});

const GuideOutcome = Schema.Struct({
  ...PullRequestIdentity,
  outcome: Schema.Literals(["started", "running", "failed"]).annotate({
    description: "started: a run began. running: joined a run for this head. failed: see detail.",
  }),
  detail: Schema.NullOr(Schema.String),
});

export const WritePullRequestGuidesResult = Schema.Struct({
  guides: Schema.Array(GuideOutcome),
});
export type WritePullRequestGuidesResult = typeof WritePullRequestGuidesResult.Type;

export const ReadPullRequestGuideResult = Schema.Struct({
  ...PullRequestIdentity,
  guide: Schema.NullOr(PullRequestReviewGuide),
  run: Schema.NullOr(PullRequestReviewGuideRun),
  currentHeadSha: Schema.NullOr(Schema.String),
  stale: Schema.Boolean.annotate({
    description: "True when the PR head moved after the guide was written.",
  }),
});
export type ReadPullRequestGuideResult = typeof ReadPullRequestGuideResult.Type;

const WritePullRequestGuidesTool = Tool.make("write_pull_request_guides", {
  description:
    "Write review guides for up to 20 PRs (the tour in the PR Guide tab). Returns once runs start. Each run takes minutes in a temporary checkout. A run for the same head is joined. Read with `read_pull_request_guide`. Fails while guides are off.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    pullRequests: Schema.Array(GuideTarget).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  success: WritePullRequestGuidesResult,
  failure: PullRequestToolError,
  dependencies: guideDependencies,
})
  .annotate(Tool.Title, "Write pull request guides")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ReadPullRequestGuideTool = Tool.make("read_pull_request_guide", {
  description:
    "Read a PR's stored review guide and run state. `guide` is null when none exists. Never starts a run.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...GuideTarget.fields,
  }),
  success: ReadPullRequestGuideResult,
  failure: PullRequestToolError,
  dependencies: guideDependencies,
})
  .annotate(Tool.Title, "Read pull request guide")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadPullRequestInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  number: Schema.optional(PositiveInt.annotate({ description: "Default: the branch's PR." })),
  repository: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadPullRequestInput = typeof ThreadPullRequestInput.Type;

export const PullRequestReadSection = Schema.Literals([
  "summary",
  "checks",
  "conversation",
  "diff",
]);
export type PullRequestReadSection = typeof PullRequestReadSection.Type;

const ReadComment = Schema.Struct({
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
});

export const ReadPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      state: PullRequestState,
      isDraft: Schema.Boolean,
      author: Schema.NullOr(Schema.String),
      headBranch: Schema.String,
      baseBranch: Schema.String,
      headSha: Schema.NullOr(Schema.String),
      mergeability: PullRequestMergeability,
      behindBy: Schema.NullOr(Schema.Int),
      autoMergeEnabled: Schema.NullOr(Schema.Boolean),
      additions: Schema.Int,
      deletions: Schema.Int,
      changedFiles: Schema.Int,
      labels: Schema.Array(Schema.String),
      reviewers: Schema.Array(Schema.String),
    }),
  ),
  checks: Schema.optional(Schema.Array(PullRequestCheck)),
  conversation: Schema.optional(
    Schema.Struct({
      comments: Schema.Array(
        Schema.Struct({
          ...ReadComment.fields,
          id: Schema.String,
          kind: PullRequestCommentKind,
          path: Schema.NullOr(Schema.String),
          reviewState: Schema.NullOr(Schema.String),
        }),
      ),
      reviewThreads: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          path: Schema.String,
          line: Schema.NullOr(Schema.Int),
          isResolved: Schema.Boolean,
          isOutdated: Schema.Boolean,
          comments: Schema.Array(ReadComment),
          moreComments: Schema.Boolean,
        }),
      ),
      hiddenResolvedThreads: Schema.Int,
      truncated: Schema.Boolean,
      nextCursor: Schema.NullOr(Schema.String),
    }),
  ),
  diff: Schema.optional(
    Schema.Struct({
      patch: Schema.String,
      truncated: Schema.Boolean,
      nextCursor: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ReadPullRequestResult = typeof ReadPullRequestResult.Type;

export const ListPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(
    Schema.Struct({
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      author: Schema.NullOr(Schema.String),
      headBranch: Schema.String,
      baseBranch: Schema.String,
      state: PullRequestState,
      isDraft: Schema.Boolean,
      reviewDecision: Schema.NullOr(PullRequestReviewDecision),
      checksState: Schema.NullOr(PullRequestChecksState),
      updatedAt: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});
export type ListPullRequestsResult = typeof ListPullRequestsResult.Type;

export const CreatePullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  created: Schema.Boolean.annotate({
    description: "False when the branch already had an open PR.",
  }),
  next: Schema.optional(Schema.String),
});
export type CreatePullRequestResult = typeof CreatePullRequestResult.Type;

export const RespondToPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  replied: Schema.Boolean,
  resolved: Schema.NullOr(Schema.Boolean),
});
export type RespondToPullRequestResult = typeof RespondToPullRequestResult.Type;

export const MergePullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  state: PullRequestState.annotate({
    description: "open while auto-merge or a merge queue waits for checks.",
  }),
});
export type MergePullRequestResult = typeof MergePullRequestResult.Type;

const ReadPullRequestTool = Tool.make("pull_request_read", {
  description: "Read a PR's state, checks, review comments, or diff. Use instead of gh or cafe.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    sections: Schema.optional(
      Schema.Array(PullRequestReadSection).annotate({
        description: "Default: summary, checks. conversation has review threads.",
      }),
    ),
    includeResolved: Schema.optional(Schema.Boolean),
    cursor: Schema.optional(TrimmedNonEmptyString),
  }),
  success: ReadPullRequestResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Read pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ListPullRequestsTool = Tool.make("pull_request_list", {
  description: "List PRs in this thread's repository, recently updated first.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    state: Schema.optional(PullRequestListState.annotate({ description: "Default: open." })),
    involvement: Schema.optional(PullRequestInvolvement),
    query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    cursor: Schema.optional(TrimmedNonEmptyString),
  }),
  success: ListPullRequestsResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "List pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CreatePullRequestTool = Tool.make("pull_request_create", {
  description: "Open a PR from this thread's pushed branch and link it, or return its open PR.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    title: TrimmedNonEmptyString,
    body: Schema.String,
    base: Schema.optional(TrimmedNonEmptyString),
    draft: Schema.optional(Schema.Boolean),
  }),
  success: CreatePullRequestResult,
  failure: PullRequestToolError,
  dependencies: [...forgeDependencies, GitManager.GitManager],
})
  .annotate(Tool.Title, "Create pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const UpdateNames = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(25),
);

const UpdatePullRequestTool = Tool.make("pull_request_update", {
  description:
    "Edit a PR's title, body, labels, or reviewers, close or reopen it, or set ready (false: back to draft).",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
    ready: Schema.optional(Schema.Boolean),
    state: Schema.optional(Schema.Literals(["open", "closed"])),
    addLabels: Schema.optional(UpdateNames),
    removeLabels: Schema.optional(UpdateNames),
    requestReviewers: Schema.optional(
      UpdateNames.annotate({ description: "Logins, or org/team for a team." }),
    ),
  }),
  success: Schema.Struct(PullRequestIdentity),
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Update pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const RespondToPullRequestTool = Tool.make("pull_request_respond", {
  description:
    "Reply to, resolve, or reopen a review thread. Without reviewThreadId, comment on the PR.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    reviewThreadId: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(TrimmedNonEmptyString),
    resolved: Schema.optional(Schema.Boolean),
  }),
  success: RespondToPullRequestResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Respond on pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ReviewLineComment = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  startLine: Schema.optional(PositiveInt),
  side: Schema.optional(
    Schema.Literals(["new", "old"]).annotate({
      description: "Default new. old: line numbers in the base, for removed lines.",
    }),
  ),
  body: TrimmedNonEmptyString,
});
export type ReviewLineComment = typeof ReviewLineComment.Type;

const ReviewPullRequestTool = Tool.make("pull_request_review", {
  description:
    "Submit a review: approve, request changes, or comment, with optional line comments.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    verdict: PullRequestReviewVerdict,
    body: Schema.optional(Schema.String),
    comments: Schema.optional(Schema.Array(ReviewLineComment).check(Schema.isMaxLength(50))),
  }),
  success: Schema.Struct(PullRequestIdentity),
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Review pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MergePullRequestTool = Tool.make("pull_request_merge", {
  description:
    "Merge only when asked to land. Refuses if the head moved from expectedHeadSha (summary.headSha).",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    expectedHeadSha: TrimmedNonEmptyString,
    method: Schema.optional(PullRequestMergeMethod),
    auto: Schema.optional(
      Schema.Boolean.annotate({
        description: "Merge when required checks pass, including later pushes.",
      }),
    ),
  }),
  success: MergePullRequestResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Merge pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  LinkPullRequestsTool,
  UnlinkPullRequestTool,
  UnlinkPullRequestsTool,
  ListThreadPullRequestsTool,
  WatchPullRequestTool,
  UnwatchPullRequestTool,
  WritePullRequestGuidesTool,
  ReadPullRequestGuideTool,
  ReadPullRequestTool,
  ListPullRequestsTool,
  CreatePullRequestTool,
  UpdatePullRequestTool,
  RespondToPullRequestTool,
  ReviewPullRequestTool,
  MergePullRequestTool,
);
