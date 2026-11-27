import {
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  PullRequestFailureReport,
  PullRequestFailuresInput,
  PullRequestFeedbackReport,
  PullRequestOperationError,
  PullRequestRateLimited,
  PullRequestReadInput,
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
  PullRequestStatusInput,
  PullRequestStatusReport,
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
import * as PullRequestOracle from "../../../pullRequest/PullRequestOracle.ts";
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
import { PullRequestProjectNotFoundError } from "../../../pullRequest/pullRequestTargets.ts";

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

const readDependencies = [
  McpInvocationContext.McpInvocationContext,
  PullRequestOracle.PullRequestOracle,
];

const watchDependencies = [...dependencies, PullRequestWatchService.PullRequestWatchService];

export const PullRequestTargetInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Default: this thread.",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Pair with number if no URL.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Pair with repo if no URL.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: project host.",
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
  PullRequestOracle.PullRequestOracleNoTargetError,
  PullRequestOracle.PullRequestOracleAmbiguousTargetError,
  PullRequestOperationError,
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
  "End your reply with the `report` line from pull_request_status.";

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
  watching: Schema.Boolean.annotate({
    description: "Whether T3 Code now watches the pull request for this thread.",
  }),
  wasWatching: Schema.Boolean.annotate({
    description: "Whether it was already watched before the call.",
  }),
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
    "Link a PR to this thread for status and settlement on merge. Batch: link_pull_requests.",
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
  description: "Batch-link PRs to a thread; non-PR URLs return in invalidUrls.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Default: this thread." })),
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
  description: "Unlink a PR from this thread; wasLinked=false if absent.",
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
  description: "Batch-unlink this thread's PRs by last known state; keep unknown states.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Default: this thread." })),
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
    "List linked PRs, last known state and stack order (bottom up). Not a readiness check.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId.annotate({ description: "Default: this thread." })),
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
        'Omit to keep current. "checks" (new default): stop Working when checks finish, for user handoff. "merged": stay Working until merge, close or unwatch, when you will act yourself (e.g. merge after approval).',
    }),
  ),
});

const WatchPullRequestTool = Tool.make("watch_pull_request", {
  description:
    "Handle comments, then link/watch an open PR and end your turn. Wakes on failed checks, passed required checks, new comments/reviews or conflicts; once on merge/close unless you used CLI. Persists; don't rearm. Check readiness before merging.",
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
  description: "Stop this thread's PR watch without unlinking.",
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
    "Start review guides for up to 20 PRs; join an existing run for the same head. Runs take minutes in temporary checkouts. Requires guides enabled. Read with read_pull_request_guide.",
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
    "Read saved PR review guide and run state; guide=null if absent. Does not start a run.",
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

const PullRequestStatusTool = Tool.make("pull_request_status", {
  description:
    "Cached PR head, failing/waiting check names, review decision and mergeability. Replaces gh pr view/checks and gh run view. Quote final report line; read once per decision. Parents use watch_pull_request; subagents report.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...PullRequestStatusInput.fields,
  }),
  success: PullRequestStatusReport,
  failure: PullRequestToolError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Pull request status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PullRequestFailuresTool = Tool.make("pull_request_failures", {
  description:
    "One PR's failed steps, annotations and bounded error log excerpts. Replaces gh run view --log-failed and job logs API.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...PullRequestFailuresInput.fields,
  }),
  success: Schema.Union([PullRequestFailureReport, PullRequestRateLimited]),
  failure: PullRequestToolError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Pull request CI failures")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const PullRequestFeedbackTool = Tool.make("pull_request_feedback", {
  description:
    "One PR's unresolved review threads, verdicts, comments and bot findings, newest first. Call per PR; replaces reviews, comments and reviewThreads APIs.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...PullRequestReadInput.fields,
  }),
  success: Schema.Union([PullRequestFeedbackReport, PullRequestRateLimited]),
  failure: PullRequestToolError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Pull request feedback")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadPullRequestInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  number: Schema.optional(PositiveInt.annotate({ description: "Default: branch PR." })),
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
  note: Schema.optional(Schema.String),
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
  description: "List PRs in this thread's repo, newest updates first.",
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
      description: "Visible to writers only; branch stays off origin. Unsupported hosts fail.",
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
    "Edit title, body, labels or reviewers; close/reopen or set ready (false makes draft).",
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
    "Reply to, resolve or reopen a review thread; omit reviewThreadId to comment on the PR.",
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
    "Submit a review: approve, request changes, or comment, with optional line comments. Approving needs expectedHeadSha (headSha in pull_request_read). Refuses if the head moved from it.",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    verdict: PullRequestReviewVerdict,
    expectedHeadSha: Schema.optional(TrimmedNonEmptyString),
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
    "Merge a PR only if its head still matches expectedHeadSha (pull_request_read.headSha).",
  parameters: Schema.Struct({
    ...ThreadPullRequestInput.fields,
    expectedHeadSha: TrimmedNonEmptyString,
    method: Schema.optional(PullRequestMergeMethod),
    auto: Schema.optional(
      Schema.Boolean.annotate({
        description: "Merge after required checks pass, even after pushes.",
      }),
    ),
    stack: Schema.optional(
      Schema.Boolean.annotate({
        description: "Merge this PR and every open stack layer below it at once.",
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
  description: "Rerun failing PR checks or one named check.",
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
  PullRequestStatusTool,
  PullRequestFailuresTool,
  PullRequestFeedbackTool,
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
