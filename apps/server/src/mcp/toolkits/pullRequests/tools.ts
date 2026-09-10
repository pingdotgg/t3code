import {
  McpCapabilityUnavailableError,
  PositiveInt,
  PullRequestState,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestratorV2,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

const REGISTER_EVERY_PR =
  "Register every pull request you open for this thread, including each layer of a stack, right after creating it.";

/**
 * Either the pull request's URL or its repository and number. Both forms
 * resolve to the same host-level identity, so the agent can pass whichever
 * the host CLI handed back.
 */
export const PullRequestTargetInput = Schema.Struct({
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
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
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

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
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
  description: `List the pull requests linked to this thread with their last known host state, and how they chain into stacks (bottom to top). ${REGISTER_EVERY_PR}`,
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread pull requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
);
