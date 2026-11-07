import * as Effect from "effect/Effect";
import * as RequestResolver from "effect/RequestResolver";
import * as Schema from "effect/Schema";
import { GraphQLClient, GraphQLClientError, GraphQLResolver } from "effect/graphql";
import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { pullRequestLookup } from "./gitHubPullRequestJson.ts";
import { PullRequestBatchesGraphQLGroup } from "./pullRequestBatches.graphql.ts";

export class GitHubPullRequestQueuedError extends Schema.TaggedError<GitHubPullRequestQueuedError>()(
  "GitHubPullRequestQueuedError",
  { repository: Schema.String, number: Schema.Int },
) {
  override get message(): string {
    return `PR #${this.number} is already in the merge queue. Refresh it before trying to merge again.`;
  }
}

export class GitHubPullRequestQueueReadError extends Schema.TaggedError<GitHubPullRequestQueueReadError>()(
  "GitHubPullRequestQueueReadError",
  { repository: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub returned an unreadable merge queue state.";
  }
}

export const readGitHubPullRequestQueue = Effect.fn("GitHubPullRequestQueue.read")(
  function* (input: {
    readonly host: string;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) {
    if (input.host.toLowerCase() !== "github.com" || input.numbers.length === 0)
      return new Map<number, boolean>();
    const lookup = pullRequestLookup({
      repository: input.repository,
      number: input.numbers[0] ?? 0,
    });
    if (lookup === null)
      return yield* new GitHubPullRequestQueueReadError({
        repository: input.repository,
        cause: new Error("Invalid pull request selector."),
      });
    const client = yield* GraphQLClient.make(
      PullRequestBatchesGraphQLGroup.middleware(GitHubGraphQlClient.GitHubGraphQlAuth),
    ).pipe(Effect.provide(GitHubGraphQlClient.layer));
    const resolver = GraphQLResolver.aliased(client.PullRequestQueueMembership, {
      batchKey: GitHubGraphQlClient.batchKey,
    }).pipe(RequestResolver.batchN(25));
    const entries = yield* Effect.forEach(
      input.numbers,
      (number) =>
        GraphQLResolver.request({ ...lookup, number }, resolver).pipe(
          Effect.flatMap((result) => {
            const queued = result.repository?.pullRequest?.isInMergeQueue;
            return queued === undefined
              ? Effect.fail(
                  new GitHubPullRequestQueueReadError({
                    repository: input.repository,
                    cause: new Error("Missing queue membership."),
                  }),
                )
              : Effect.succeed([number, queued] satisfies [number, boolean]);
          }),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      GitHubGraphQlClient.call({
        host: input.host,
        operation: "readPullRequestQueue",
        allowReserve: true,
      }),
      Effect.catchIf(
        GraphQLClientError.isGraphQLClientError,
        (cause) => new GitHubPullRequestQueueReadError({ repository: input.repository, cause }),
      ),
    );
    return new Map(entries);
  },
);
