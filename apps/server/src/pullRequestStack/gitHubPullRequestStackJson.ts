import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestLocalStack,
  type PullRequestStackStepState,
  type PullRequestStackSummary,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

const GitHubRemoteStackPullRequest = Schema.Struct({
  number: PositiveInt,
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  head: Schema.Struct({
    ref: TrimmedNonEmptyString,
    sha: Schema.optional(Schema.String),
  }),
});

const GitHubRemoteStack = Schema.Struct({
  id: PositiveInt,
  number: PositiveInt,
  url: Schema.String,
  base: Schema.Struct({ ref: TrimmedNonEmptyString }),
  open: Schema.Boolean,
  pull_requests: Schema.Array(GitHubRemoteStackPullRequest),
});

const GitHubLocalStackPullRequest = Schema.Struct({
  number: PositiveInt,
  url: Schema.optional(Schema.String),
  state: Schema.Literals(["OPEN", "MERGED", "QUEUED"]),
});

const GitHubLocalStack = Schema.Struct({
  trunk: TrimmedNonEmptyString,
  currentBranch: TrimmedNonEmptyString,
  branches: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      head: Schema.optional(TrimmedNonEmptyString),
      base: Schema.optional(TrimmedNonEmptyString),
      isCurrent: Schema.Boolean,
      isMerged: Schema.Boolean,
      isQueued: Schema.Boolean,
      needsRebase: Schema.Boolean,
      pr: Schema.optional(GitHubLocalStackPullRequest),
    }),
  ),
});

const decodeRemoteStacks = decodeJsonResult(Schema.Array(GitHubRemoteStack));
const decodeLocalStack = decodeJsonResult(GitHubLocalStack);

function remoteStepState(
  state: Schema.Schema.Type<typeof GitHubRemoteStackPullRequest>["state"],
  mergedAt: string | null | undefined,
): PullRequestStackStepState {
  if (mergedAt?.trim()) return "merged";
  return state === "closed" ? "closed" : "open";
}

function localStepState(input: {
  readonly state: Schema.Schema.Type<typeof GitHubLocalStackPullRequest>["state"];
  readonly isMerged: boolean;
  readonly isQueued: boolean;
}): PullRequestStackStepState {
  if (input.isMerged || input.state === "MERGED") return "merged";
  if (input.isQueued || input.state === "QUEUED") return "queued";
  return "open";
}

function normalizeRemoteStack(
  stack: Schema.Schema.Type<typeof GitHubRemoteStack>,
): PullRequestStackSummary {
  return {
    id: stack.id,
    number: stack.number,
    url: stack.url,
    baseBranch: stack.base.ref,
    open: stack.open,
    steps: stack.pull_requests.map((pullRequest, index) => ({
      position: index + 1,
      pullRequestNumber: pullRequest.number,
      branch: pullRequest.head.ref,
      state: remoteStepState(pullRequest.state, pullRequest.merged_at),
      draft: pullRequest.draft,
    })),
  };
}

function normalizeLocalStack(
  stack: Schema.Schema.Type<typeof GitHubLocalStack>,
): PullRequestLocalStack {
  return {
    trunk: stack.trunk,
    currentBranch: stack.currentBranch,
    steps: stack.branches.map((branch, index) => ({
      position: index + 1,
      branch: branch.name,
      ...(branch.head === undefined ? {} : { head: branch.head }),
      ...(branch.base === undefined ? {} : { base: branch.base }),
      isCurrent: branch.isCurrent,
      isMerged: branch.isMerged,
      isQueued: branch.isQueued,
      needsRebase: branch.needsRebase,
      pullRequest:
        branch.pr === undefined
          ? null
          : {
              number: branch.pr.number,
              ...(branch.pr.url === undefined ? {} : { url: branch.pr.url }),
              state: localStepState({ ...branch.pr, ...branch }),
            },
    })),
  };
}

export function decodeGitHubRemoteStacksJson(
  raw: string,
): Result.Result<ReadonlyArray<PullRequestStackSummary>, Cause.Cause<Schema.SchemaError>> {
  return Result.map(decodeRemoteStacks(raw), (stacks) => stacks.map(normalizeRemoteStack));
}

export function decodeGitHubLocalStackJson(
  raw: string,
): Result.Result<PullRequestLocalStack, Cause.Cause<Schema.SchemaError>> {
  return Result.map(decodeLocalStack(raw), normalizeLocalStack);
}
