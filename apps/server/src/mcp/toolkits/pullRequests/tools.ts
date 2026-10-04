import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PositiveInt,
  PullRequestBaseComparison,
  PullRequestCheck,
  PullRequestCommentKind,
  PullRequestDiffSide,
  PullRequestMergeability,
  PullRequestReviewerKind,
  PullRequestState,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const REGISTER_EVERY_PR =
  "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

/**
 * Either the pull request's URL or its repository and number. Both forms
 * resolve to the same host-level identity, so the agent can pass whichever
 * the host CLI handed back.
 */
export const PullRequestTargetInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread to act on. Omit for this thread.",
    }),
  ),
  url: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "The pull request's web URL, for example https://github.com/owner/repo/pull/123. Preferred when you have it; host, repository and number are read from it.",
    }),
  ),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Repository path below the host, for example owner/repo. Required with number when url is omitted.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "Pull request number. Required with repository when url is omitted.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Host the repository lives on, for example github.com. Defaults to the host of this thread's project.",
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

export class PullRequestThreadRequiredError extends Schema.TaggedError<PullRequestThreadRequiredError>()(
  "PullRequestThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class PullRequestThreadAboveLimitsError extends Schema.TaggedError<PullRequestThreadAboveLimitsError>()(
  "PullRequestThreadAboveLimitsError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} cannot be changed from here: it runs with broader permissions than this caller, or the calling thread has no active run.`;
  }
}

export class PullRequestThreadNotFoundError extends Schema.TaggedError<PullRequestThreadNotFoundError>()(
  "PullRequestThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
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

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
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

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export const PullRequestToolError = Schema.Union([
  McpCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestThreadRequiredError,
  PullRequestThreadAboveLimitsError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchFailedError,
  PullRequestNotOpenError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean.annotate({
    description: "True when the pull request was linked to this thread before the call.",
  }),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean.annotate({
    description: "False when the pull request was not linked to this thread to begin with.",
  }),
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const WatchPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  watching: Schema.Boolean.annotate({
    description: "Whether T3 Code now watches the pull request for this thread.",
  }),
  wasWatching: Schema.Boolean.annotate({
    description: "Whether it was already watched before the call.",
  }),
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
      /** 1-based, bottom of the stack first. */
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
      /** Bottom to top. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;

const LinkPullRequestTool = Tool.make("link_pull_request", {
  description: `${REGISTER_EVERY_PR} Links a pull request to this thread so T3 Code tracks it, shows its status beside the thread, and settles the thread when it merges. Pass the URL, or repository plus number. Linking an already-linked pull request succeeds with alreadyLinked=true.`,
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

const UnlinkPullRequestTool = Tool.make("unlink_pull_request", {
  description:
    "Remove a pull request link from this thread, for example after closing a pull request you opened by mistake. Pass the URL, or repository plus number. Unlinking a pull request that is not linked succeeds with wasLinked=false.",
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

const ListThreadPullRequestsTool = Tool.make("list_thread_pull_requests", {
  description: `List the pull requests linked to a thread (omit threadId for this thread) with their last known host state, and how they chain into stacks (bottom to top). ${REGISTER_EVERY_PR}`,
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Thread to list. Omit for this thread." }),
    ),
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
    "Have T3 Code watch an open pull request for this thread, linking it first if needed. T3 Code checks it every minute and wakes you with a message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict with its base. Use this to monitor or babysit a pull request instead of polling, sleeping, or running a watcher. Only comments posted after this call wake you, so handle the existing ones first, then end your turn. A wake is news, not a merge decision: check readiness yourself before merging. Watching ends when the pull request merges or closes, when T3 Code cannot read it for 15 minutes, or when you call unwatch_pull_request.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnwatchPullRequestTool = Tool.make("unwatch_pull_request", {
  description:
    "Stop T3 Code from watching a pull request for this thread. The pull request stays linked. Pass the URL, or repository plus number.",
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const hostDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  PullRequestService.PullRequestService,
];

const MAX_PULL_REQUEST_CHARACTERS = 100_000;

const ThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
  url: Schema.NullOr(Schema.String),
});

const ReadPullRequestTool = Tool.make("t3_pull_request_read", {
  description:
    "Read a pull request from its host (pass url, or repository plus number; threadId picks the project whose credentials are used, default this thread). section: overview (default: title, body, state, branches, mergeability, reviewers, labels, checks), checks (current check runs), conversation (comments and line review threads with resolution state; spend the text budget on unresolved threads and the newest comments first), or review_thread (more comments of one review thread: pass reviewThreadId and the cursor from its nextCommentsCursor). Text is cut to maxCharacters in total (default 20,000, max 100,000) with truncated set when cut. Check logs are not available; follow a check's url.",
  parameters: Schema.Struct({
    ...PullRequestTargetInput.fields,
    section: Schema.optional(
      Schema.Literals(["overview", "checks", "conversation", "review_thread"]),
    ),
    reviewThreadId: Schema.optional(TrimmedNonEmptyString),
    cursor: Schema.optional(TrimmedNonEmptyString),
    maxCharacters: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PULL_REQUEST_CHARACTERS })),
    ),
  }),
  success: Schema.Struct({
    ...PullRequestIdentity,
    overview: Schema.NullOr(
      Schema.Struct({
        title: Schema.String,
        body: Schema.String,
        state: PullRequestState,
        isDraft: Schema.Boolean,
        author: Schema.NullOr(Schema.String),
        headBranch: Schema.String,
        baseBranch: Schema.String,
        mergeability: PullRequestMergeability,
        baseComparison: Schema.NullOr(PullRequestBaseComparison),
        autoMergeEnabled: Schema.NullOr(Schema.Boolean),
        additions: Schema.Int,
        deletions: Schema.Int,
        changedFiles: Schema.Int,
        createdAt: Schema.String,
        updatedAt: Schema.String,
        reviewers: Schema.Array(Schema.String),
        labels: Schema.Array(Schema.String),
        checks: Schema.Array(PullRequestCheck),
      }),
    ),
    checks: Schema.NullOr(Schema.Array(PullRequestCheck)),
    conversation: Schema.NullOr(
      Schema.Struct({
        /** The host's own count, which can exceed what was read. */
        commentCount: Schema.Int,
        comments: Schema.Array(
          Schema.Struct({
            ...ThreadComment.fields,
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
            side: PullRequestDiffSide,
            isResolved: Schema.Boolean,
            isOutdated: Schema.Boolean,
            comments: Schema.Array(ThreadComment),
            nextCommentsCursor: Schema.NullOr(Schema.String),
          }),
        ),
      }),
    ),
    reviewThread: Schema.NullOr(
      Schema.Struct({
        comments: Schema.Array(ThreadComment),
        nextCursor: Schema.NullOr(Schema.String),
      }),
    ),
    truncated: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostDependencies,
})
  .annotate(Tool.Title, "Read pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const UpdatePullRequestTool = Tool.make("t3_pull_request_update", {
  description:
    "Act on a pull request on its host (pass url, or repository plus number). comment posts body on the conversation; reply posts body to a line review thread (reviewThreadId from t3_pull_request_read section conversation); resolve and unresolve that thread; request_reviewers and unrequest_reviewers take reviewers (logins, or team slugs with kind team); add_labels and remove_labels take label names. Posts appear under the host account this environment is signed in with. Merging, closing, approving, and editing the title or body are not available here. Needs a full-access/default caller.",
  parameters: Schema.Struct({
    ...PullRequestTargetInput.fields,
    action: Schema.Literals([
      "comment",
      "reply",
      "resolve",
      "unresolve",
      "request_reviewers",
      "unrequest_reviewers",
      "add_labels",
      "remove_labels",
    ]),
    body: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65_536))),
    reviewThreadId: Schema.optional(TrimmedNonEmptyString),
    reviewers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: TrimmedNonEmptyString,
          kind: Schema.optional(PullRequestReviewerKind),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
    ),
    labels: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
    ),
  }),
  success: Schema.Struct({ ...PullRequestIdentity, action: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: hostDependencies,
})
  .annotate(Tool.Title, "Comment on or update pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
  WatchPullRequestTool,
  UnwatchPullRequestTool,
  ReadPullRequestTool,
  UpdatePullRequestTool,
);
