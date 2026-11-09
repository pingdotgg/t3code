import {
  IsoDateTime,
  McpCapabilityUnavailableError,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  PullRequestCapabilities,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestListState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestReviewGuide,
  PullRequestReviewGuideRun,
  PullRequestState,
  SourceControlProviderKind,
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
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const guideDependencies = [
  ...dependencies,
  PullRequestReviewGuideService.PullRequestReviewGuideService,
];

// Observation tools bind to a project, never to a thread, so external read-only clients can use them.
const readDependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectService.ProjectService,
  PullRequestService.PullRequestService,
];

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

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

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
  {},
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedError<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  {},
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  {},
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotOpenError extends Schema.TaggedError<PullRequestNotOpenError>()(
  "PullRequestNotOpenError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The pull request is ${this.state}, so there is nothing to watch.`;
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";
  }
}

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  {},
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
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class PullRequestProjectUnknownError extends Schema.TaggedError<PullRequestProjectUnknownError>()(
  "PullRequestProjectUnknownError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found, so its pull requests cannot be read here.`;
  }
}

export class PullRequestProjectMismatchError extends Schema.TaggedError<PullRequestProjectMismatchError>()(
  "PullRequestProjectMismatchError",
  {
    projectId: ProjectId,
    repository: Schema.String,
    host: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const where = this.host === undefined ? this.repository : `${this.host}/${this.repository}`;
    return `Project ${this.projectId} is not a checkout of ${where}.`;
  }
}

export class PullRequestReadFailedError extends Schema.TaggedError<PullRequestReadFailedError>()(
  "PullRequestReadFailedError",
  // Only the service's own sanitized message crosses MCP; its cause stays server-side.
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
  PullRequestWatchFailedError,
  PullRequestNotOpenError,
  PullRequestWatchFromSubagentError,
  PullRequestProjectNotFoundError,
  PullRequestGuideFailedError,
  PullRequestProjectUnknownError,
  PullRequestProjectMismatchError,
  PullRequestReadFailedError,
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
  dependencies,
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
  dependencies,
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

const PullRequestActorView = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
});

const PullRequestLabelView = Schema.Struct({ name: TrimmedNonEmptyString });

export const PullRequestListItem = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  mergeability: PullRequestMergeability,
  author: Schema.NullOr(PullRequestActorView),
  labels: Schema.Array(PullRequestLabelView),
  reviewDecision: Schema.optional(PullRequestReviewDecision),
  checksState: Schema.optional(PullRequestChecksState),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  observedAt: Schema.optional(Schema.Finite),
});
export type PullRequestListItem = typeof PullRequestListItem.Type;

export const ListPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(PullRequestListItem),
  providers: Schema.Array(
    Schema.Struct({
      host: TrimmedNonEmptyString,
      kind: SourceControlProviderKind,
      configured: Schema.Boolean,
      detail: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  errors: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      projectTitle: TrimmedNonEmptyString,
      message: TrimmedNonEmptyString,
    }),
  ),
  errorsTruncated: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type ListPullRequestsResult = typeof ListPullRequestsResult.Type;

export const PullRequestChecksView = Schema.Struct({
  observedAt: Schema.NullOr(Schema.Finite),
  state: PullRequestState,
  items: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      status: PullRequestCheckStatus,
      required: Schema.optional(Schema.Boolean),
    }),
  ),
  truncated: Schema.Boolean,
});
export type PullRequestChecksView = typeof PullRequestChecksView.Type;

export const ReadPullRequestResult = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  mergeability: PullRequestMergeability,
  headSha: Schema.NullOr(Schema.String).annotate({
    description:
      "Null when the host does not report it. Compare against later reads for staleness.",
  }),
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  author: Schema.NullOr(PullRequestActorView),
  reviewers: Schema.Array(PullRequestActorView),
  labels: Schema.Array(PullRequestLabelView),
  checks: Schema.NullOr(PullRequestChecksView).annotate({
    description: "Null when the host reports no checks, not that none ran.",
  }),
  checksError: Schema.NullOr(Schema.String).annotate({
    description:
      "Set when the checks read itself failed. Null checks without this mean the host reports none.",
  }),
  capabilities: PullRequestCapabilities,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  mergedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  observedAt: Schema.NullOr(Schema.Finite),
});
export type ReadPullRequestResult = typeof ReadPullRequestResult.Type;

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

const ListPullRequestsTool = Tool.make("t3_pull_request_list", {
  description:
    "List pull requests for the environment or one project, read-only. Hosts that cannot be read stay visible under `providers` and `errors`. Read one with `t3_pull_request_read`.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({
        description: "One project. Default: every project on a supported host.",
      }),
    ),
    host: Schema.optional(TrimmedNonEmptyString.annotate({ description: "One host." })),
    state: Schema.optional(PullRequestListState.annotate({ description: "Default: open." })),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: "Default: 20.",
      }),
    ),
  }),
  success: ListPullRequestsResult,
  failure: PullRequestToolError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "List pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ReadPullRequestTool = Tool.make("t3_pull_request_read", {
  description:
    "Read one pull request through its project: safe fields, a bounded body, the check list, and what the host supports. `checks` is null when the host reports none. `headSha` and `observedAt` date the read. Read-only; never mutates.",
  parameters: Schema.Struct({
    projectId: ProjectId.annotate({
      description: "Project whose checkout holds the repository.",
    }),
    repository: TrimmedNonEmptyString.annotate({
      description: "With `number`. Owner and repo, or the host's own repository path.",
    }),
    number: PositiveInt,
    host: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Default: the project's host." }),
    ),
  }),
  success: ReadPullRequestResult,
  failure: PullRequestToolError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Read pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
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
  ListPullRequestsTool,
  ReadPullRequestTool,
);
