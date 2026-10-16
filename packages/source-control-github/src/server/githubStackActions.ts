import type {
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestStackHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { GraphQLClient, GraphQLClientError, GraphQLResolver } from "effect/graphql";
import * as RequestResolver from "effect/RequestResolver";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { decodePullRequestStacksJson, toCanWrite } from "./gitHubPullRequestJson.ts";
import { cascadeRebaseStack } from "./githubStackRebase.ts";
import { StackActionsGraphQLGroup } from "./stackActions.graphql.ts";

const stackErrorIdentity = {
  repository: Schema.String,
  number: Schema.Int,
  stackNumber: Schema.Int,
};

export class GitHubStackChangedError extends Schema.TaggedError<GitHubStackChangedError>()(
  "GitHubStackChangedError",
  { ...stackErrorIdentity, completed: Schema.Int },
) {
  override get message(): string {
    return this.completed > 0
      ? `The stack changed at PR #${this.number} after ${this.completed} layers. Earlier updates remain on GitHub. Refresh it before trying again.`
      : "The stack changed. Refresh it before trying again.";
  }
}

export class GitHubStackUnsupportedError extends Schema.TaggedError<GitHubStackUnsupportedError>()(
  "GitHubStackUnsupportedError",
  stackErrorIdentity,
) {
  override get message(): string {
    return "This operation is not supported for this stack.";
  }
}

export class GitHubStackResponseInvalidError extends Schema.TaggedError<GitHubStackResponseInvalidError>()(
  "GitHubStackResponseInvalidError",
  { ...stackErrorIdentity, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "GitHub returned an unreadable stack operation response.";
  }
}

export class GitHubStackMergeRejectedError extends Schema.TaggedError<GitHubStackMergeRejectedError>()(
  "GitHubStackMergeRejectedError",
  { ...stackErrorIdentity, cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub refused the stack merge. Check the stack's branch rules and merge requirements.";
  }
}

export class GitHubStackMergePendingError extends Schema.TaggedError<GitHubStackMergePendingError>()(
  "GitHubStackMergePendingError",
  stackErrorIdentity,
) {
  override get message(): string {
    return "The merge is still running on GitHub. Check its status there before submitting another request.";
  }
}

export class GitHubStackPermissionError extends Schema.TaggedError<GitHubStackPermissionError>()(
  "GitHubStackPermissionError",
  stackErrorIdentity,
) {
  override get message(): string {
    return "You cannot update every branch in this stack. Check write access and fork maintainer permissions before retrying.";
  }
}

export class GitHubStackRebaseFailedError extends Schema.TaggedError<GitHubStackRebaseFailedError>()(
  "GitHubStackRebaseFailedError",
  { ...stackErrorIdentity, completed: Schema.Int, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.cause instanceof Error && this.cause.message !== ""
      ? this.cause.message
      : `Stack rebase stopped at PR #${this.number} after ${this.completed} layers. Earlier updates remain on GitHub; resolve the failing layer before retrying.`;
  }
}

export type GitHubStackActionError =
  | GitHubStackChangedError
  | GitHubStackUnsupportedError
  | GitHubStackResponseInvalidError
  | GitHubStackMergeRejectedError
  | GitHubStackMergePendingError
  | GitHubStackPermissionError
  | GitHubStackRebaseFailedError;

const MergeResponse = Schema.Struct({
  status: Schema.Literals(["pending", "merged", "enqueued", "failed"]),
  details: Schema.Struct({
    uuid: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
});

const decodeMergeResponse = Schema.decodeEffect(Schema.fromJsonString(MergeResponse));

export const runGitHubStackAction = Effect.fn("runGitHubStackAction")(function* (input: {
  cwd: string;
  repository: string;
  host: string;
  number: number;
  stackNumber: number;
  expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
  action: PullRequestAction;
  mergeMethod?: PullRequestMergeMethod;
}) {
  const api = yield* GitHubRest.GitHubRest;
  const identity = {
    repository: input.repository,
    number: input.number,
    stackNumber: input.stackNumber,
  };
  if (input.action !== "merge" && input.action !== "update-branch")
    return yield* new GitHubStackUnsupportedError({ ...identity });
  const endpoint = `repos/${input.repository}`;
  const read = yield* api.rest({
    host: input.host,
    operation: "runGitHubStackAction",
    path: `${endpoint}/stacks?pull_request=${input.number}`,
  });
  const decoded = decodePullRequestStacksJson(read.body);
  if (Result.isFailure(decoded))
    return yield* new GitHubStackResponseInvalidError({ ...identity, cause: decoded.failure });
  const stack = decoded.success;
  const targetIndex = stack?.layers.findIndex((layer) => layer.number === input.number) ?? -1;
  const target = stack?.layers[targetIndex];
  if (
    stack?.number !== input.stackNumber ||
    target === undefined ||
    (input.action === "update-branch" && targetIndex !== stack.layers.length - 1)
  ) {
    return yield* new GitHubStackChangedError({ ...identity, number: input.number, completed: 0 });
  }
  const affectedLayers =
    input.action === "merge" ? stack.layers.slice(0, targetIndex + 1) : stack.layers;
  const open = affectedLayers.filter((layer) => layer.state !== "merged");
  if (input.action === "merge" && target.state !== "open")
    return yield* new GitHubStackUnsupportedError({ ...identity });
  if (
    !input.expectedStackHeads ||
    input.expectedStackHeads.length !== open.length ||
    new Set(input.expectedStackHeads.map((layer) => layer.number)).size !== open.length ||
    open.some(
      (layer) =>
        !layer.headSha ||
        !input.expectedStackHeads?.some(
          (expected) => expected.number === layer.number && expected.headSha === layer.headSha,
        ),
    )
  ) {
    return yield* new GitHubStackChangedError({ ...identity, number: input.number, completed: 0 });
  }
  if (open.length === 0 || open.some((layer) => layer.state !== "open"))
    return yield* new GitHubStackUnsupportedError({ ...identity });
  if (input.action === "update-branch") {
    const [owner, name] = input.repository.split("/");
    const client = yield* GraphQLClient.make(
      StackActionsGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
    ).pipe(Effect.provide(GitHubGraphQlClient.layer));
    // One aliased request checks every layer; `open` is non-empty here.
    const resolver = GraphQLResolver.aliased(client.PullRequestBranchAccess, {
      batchKey: GitHubGraphQlClient.batchKey,
    }).pipe(RequestResolver.batchN(open.length));
    const access = yield* Effect.forEach(
      open,
      (layer) =>
        GraphQLResolver.request({ owner: owner!, name: name!, number: layer.number }, resolver),
      { concurrency: "unbounded" },
    ).pipe(
      GitHubGraphQlClient.call({
        host: input.host,
        operation: "runGitHubStackAction",
        allowReserve: true,
      }),
      Effect.catchIf(
        GraphQLClientError.isGraphQLClientError,
        (cause) => new GitHubStackResponseInvalidError({ ...identity, cause }),
      ),
    );
    // viewerCanUpdateBranch is false for an already-current layer, even if rebasing its parent
    // will make it stale. Check branch write access separately before touching any layer.
    if (
      access.some(({ repository }) => {
        const pr = repository?.pullRequest;
        return (
          !pr?.headRepository ||
          (!pr.maintainerCanModify && !toCanWrite(pr.headRepository.viewerPermission))
        );
      })
    )
      return yield* new GitHubStackPermissionError({ ...identity });
    // GitHub's own "Rebase stack" has no API, and its per-PR "update branch" replays the old
    // copy of every lower layer into the one above it. The cascade moves each layer's own commits.
    yield* cascadeRebaseStack({
      host: input.host,
      repository: input.repository,
      base: stack.base,
      layers: open.map((layer) => ({
        number: layer.number,
        headBranch: layer.headBranch,
        headSha: layer.headSha!,
      })),
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "GitHubStackRebaseConflictError" ||
        cause._tag === "GitHubStackRebaseGitError"
          ? new GitHubStackRebaseFailedError({
              ...identity,
              number: cause.number,
              completed: cause.completed,
              cause,
            })
          : cause,
      ),
    );
    return;
  }
  if (open.some((layer) => layer.isDraft))
    return yield* new GitHubStackUnsupportedError({ ...identity });
  const decode = (raw: string) =>
    decodeMergeResponse(raw).pipe(
      Effect.mapError((cause) => new GitHubStackResponseInvalidError({ ...identity, cause })),
    );
  const request = yield* api.rest({
    host: input.host,
    operation: "runGitHubStackAction",
    method: "PUT",
    path: `${endpoint}/pulls/${input.number}/merge-async`,
    body: {
      merge_method: input.mergeMethod ?? "merge",
      merge_action: "default",
      sha: target.headSha,
    },
  });
  let result = yield* decode(request.body);
  const deadline = (yield* Clock.currentTimeMillis) + 5 * 60_000;
  for (
    let attempt = 0;
    result.status === "pending" && (yield* Clock.currentTimeMillis) < deadline;
    attempt++
  ) {
    const uuid = result.details.uuid;
    if (!uuid) return yield* new GitHubStackResponseInvalidError({ ...identity });
    yield* Effect.sleep(Math.min(1_000 * 2 ** attempt, 10_000));
    const poll = yield* api.rest({
      host: input.host,
      operation: "runGitHubStackAction",
      path: `${endpoint}/pulls/${input.number}/merge-async/${encodeURIComponent(uuid)}`,
    });
    result = yield* decode(poll.body);
  }
  if (result.status === "pending") return yield* new GitHubStackMergePendingError({ ...identity });
  if (result.status === "failed")
    return yield* new GitHubStackMergeRejectedError({ ...identity, cause: result });
});
