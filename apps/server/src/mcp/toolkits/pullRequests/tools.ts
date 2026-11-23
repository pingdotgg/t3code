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
  PullRequestVisibility,
  PullRequestWatchUntil,
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
  PullRequestRepositoryInvalidError,
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
  PullRequestRepositoryInvalidError,
  PullRequestThreadRequiredError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchService.PullRequestWatchFailedError,
  PullRequestUnavailableError,
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
  state: Schema.optional(
    Schema.Literals(["merged", "closed"]).annotate({
      description: "The PR already ended, so nothing was watched.",
    }),
  ),
  checksState: Schema.optional(PullRequestChecksState),
  next: Schema.optional(Schema.String),
});
export type WatchPullRequestResult = typeof WatchPullRequestResult.Type;

export const alreadyEndedWatchNext = (state: "merged" | "closed") =>
  `This PR is already ${state}, so there is nothing to watch. Report that and end your turn.`;

export const CHECKS_ALREADY_PASSED_WATCH_NEXT =
  "Checks already pass on this head, so no wake will come for them. Act on that now; the watch still wakes you on later changes.";

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
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
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
    "Link several PRs to a thread. Use it instead of one `link_pull_request` per PR. URLs that are not PRs come back in `invalidUrls`.",
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
    "Unlink thread PRs whose last known state is in states. Unknown states stay linked. Prefer over repeated unlink_pull_request calls.",
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
    "List a thread's PRs, with last known state and stack order (bottom to top). Not an end-of-work check.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
    states: Schema.optional(Schema.Array(PullRequestState)),
    cursor: Schema.optional(Schema.String),
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

const WatchPullRequestInput = Schema.Struct({
  ...PullRequestTargetInput.fields,
  until: Schema.optional(
    PullRequestWatchUntil.annotate({
      description:
        'How long this thread stays working. Omit to keep the current value; a new watch starts at "checks". "checks": until checks finish, for a PR you hand to the user. "merged": until it merges, closes or is unwatched, when you act on it yourself, such as merging after approval.',
    }),
  ),
});

const WatchPullRequestTool = Tool.make("watch_pull_request", {
  description:
    "Watch and link an open PR here. Wakes on failed checks, required checks passing, new comments/reviews, conflicts, and once on merge/close unless via CLI. Handle old comments first. Call, then end your turn. Watch persists; never rewatch on wake. Verify merge readiness.",
  parameters: WatchPullRequestInput,
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
    "Start PR Guide tours for up to 20 PRs; returns after startup. Runs take minutes in temporary checkouts; same-head runs are joined. Read via read_pull_request_guide. Fails while guides are off.",
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
  "body",
  "checks",
  "threads",
  "comments",
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
  title: Schema.String,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  visibility: Schema.optional(PullRequestVisibility).annotate({
    description: "Only on a host with private PRs.",
  }),
  author: Schema.NullOr(Schema.String),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  headSha: Schema.NullOr(Schema.String),
  mergeability: PullRequestMergeability,
  behindBy: Schema.NullOr(Schema.Int),
  autoMergeEnabled: Schema.NullOr(Schema.Boolean),
  checks: Schema.Struct({
    passed: Schema.Int,
    pending: Schema.Int,
    failed: Schema.Array(Schema.String),
    incomplete: Schema.optional(Schema.Literal(true)).annotate({
      description: "The host could not list some checks; checkRuns says which.",
    }),
  }),
  unresolvedThreads: Schema.Int,
  unresolvedThreadsTruncated: Schema.optional(Schema.Literal(true)).annotate({
    description: "unresolvedThreads is a lower bound.",
  }),
  body: Schema.optional(Schema.String),
  checkRuns: Schema.optional(Schema.Array(PullRequestCheck)),
  conversation: Schema.optional(
    Schema.Struct({
      reviewThreads: Schema.optional(
        Schema.Array(
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
      ),
      comments: Schema.optional(
        Schema.Array(
          Schema.Struct({
            ...ReadComment.fields,
            id: Schema.String,
            kind: PullRequestCommentKind,
            path: Schema.NullOr(Schema.String),
            reviewState: Schema.NullOr(Schema.String),
          }),
        ),
      ),
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
  description: "Read a PR's state and check counts. `include` adds detail.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    include: Schema.optional(
      Schema.Array(PullRequestReadSection).annotate({
        description: "threads: unresolved review threads.",
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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

const CreatePullRequestTool = Tool.make("pull_request_create", {
  description: "Push this thread's branch, then open its PR and link it, or return its open PR.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    title: TrimmedNonEmptyString,
    body: Schema.String,
    base: Schema.optional(TrimmedNonEmptyString),
    draft: Schema.optional(Schema.Boolean),
    private: Schema.optional(Schema.Boolean).annotate({
      description:
        "Visible to writers only; the branch never reaches origin. Fails on a host without private PRs.",
    }),
  }),
  success: CreatePullRequestResult,
  failure: PullRequestToolError,
  dependencies: [...forgeDependencies, GitManager.GitManager],
})
  .annotate(Tool.Title, "Create pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

const MergePullRequestTool = Tool.make("pull_request_merge", {
  description:
    "Merge a PR. Refuses if the head moved from expectedHeadSha (headSha in pull_request_read).",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    expectedHeadSha: TrimmedNonEmptyString,
    method: Schema.optional(PullRequestMergeMethod),
    auto: Schema.optional(
      Schema.Boolean.annotate({
        description: "Merge when required checks pass, including later pushes.",
      }),
    ),
    stack: Schema.optional(
      Schema.Boolean.annotate({
        description: "Merge this PR and every open stack layer below it at once. Not with auto.",
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
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

export const CheckLogsResult = Schema.Struct({
  ...PullRequestIdentity,
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.NullOr(Schema.String),
      log: Schema.NullOr(Schema.String),
      truncated: Schema.Boolean,
      detail: Schema.NullOr(Schema.String),
    }),
  ),
});
export type CheckLogsResult = typeof CheckLogsResult.Type;

export const RerunChecksResult = Schema.Struct({
  ...PullRequestIdentity,
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      rerun: Schema.Boolean,
      detail: Schema.NullOr(Schema.String),
    }),
  ),
});
export type RerunChecksResult = typeof RerunChecksResult.Type;

const CheckLogsTool = Tool.make("ci_logs", {
  description: "Read the tail of a PR's failing check logs, or one named check's.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    check: Schema.optional(TrimmedNonEmptyString),
    tailLines: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 })).annotate({
        description: "Default: 200.",
      }),
    ),
  }),
  success: CheckLogsResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Read CI logs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

const RerunChecksTool = Tool.make("ci_rerun", {
  description: "Re-run a PR's failing checks, or one named check.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    check: Schema.optional(TrimmedNonEmptyString),
  }),
  success: RerunChecksResult,
  failure: PullRequestToolError,
  dependencies: forgeDependencies,
})
  .annotate(Tool.Title, "Re-run CI")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutForge);

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
  CheckLogsTool,
  RerunChecksTool,
);
