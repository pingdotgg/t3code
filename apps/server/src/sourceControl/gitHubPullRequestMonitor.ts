import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import type * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";

export interface PullRequestMonitorActor {
  readonly login: string;
  readonly type: "app" | "user";
}

export interface PullRequestMonitorReview {
  readonly id: string;
  readonly author: PullRequestMonitorActor;
  readonly state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending";
  readonly submittedAt: string | null;
  readonly commitSha: string | null;
}

export interface PullRequestMonitorReviewThread {
  readonly id: string;
  readonly author: PullRequestMonitorActor;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolved: boolean;
}

export interface PullRequestMonitorIssueComment {
  readonly id: string;
  readonly author: PullRequestMonitorActor;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestMonitorCheckRun {
  readonly id: string;
  readonly name: string;
  readonly status: "queued" | "in-progress" | "completed" | "unknown";
  readonly conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed-out"
    | "action-required"
    | "stale"
    | null;
  readonly startedAt: string | null;
  readonly headSha: string;
}

export interface PullRequestMonitorSnapshot {
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseRefName: string;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly behindBaseBy: number | null;
  readonly requiredChecksKnown: boolean;
  readonly monitoringStartedAt?: string;
  readonly reviews: ReadonlyArray<PullRequestMonitorReview>;
  readonly reviewThreads: ReadonlyArray<PullRequestMonitorReviewThread>;
  readonly issueComments: ReadonlyArray<PullRequestMonitorIssueComment>;
  readonly checkRuns: ReadonlyArray<PullRequestMonitorCheckRun>;
}

const ActorSchema = Schema.Struct({
  login: Schema.String,
  __typename: Schema.String,
});
const ReviewSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(ActorSchema),
  state: Schema.String,
  submittedAt: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
});
const ThreadSchema = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: Schema.NullOr(ActorSchema),
        body: Schema.String,
        path: Schema.NullOr(Schema.String),
        line: Schema.NullOr(Schema.Number),
        createdAt: Schema.String,
        updatedAt: Schema.String,
      }),
    ),
  }),
});
const PullRequestPageSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          state: Schema.String,
          isDraft: Schema.Boolean,
          merged: Schema.Boolean,
          mergeable: Schema.String,
          headRefOid: Schema.String,
          baseRefName: Schema.String,
          reviews: Schema.Struct({
            nodes: Schema.Array(ReviewSchema),
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
          }),
          reviewThreads: Schema.Struct({
            nodes: Schema.Array(ThreadSchema),
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
          }),
        }),
      ),
    }),
  }),
});
const RepoSchema = Schema.Struct({ nameWithOwner: Schema.String });
const IssueCommentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.Struct({ login: Schema.String, type: Schema.String }),
    body: Schema.String,
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);
const CheckRunsSchema = Schema.Struct({
  total_count: Schema.Number,
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      started_at: Schema.NullOr(Schema.String),
      head_sha: Schema.String,
    }),
  ),
});

export class GitHubPullRequestMonitorDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestMonitorDecodeError>()(
  "GitHubPullRequestMonitorDecodeError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type GitHubPullRequestMonitorError =
  | GitHubCli.GitHubCliError
  | GitHubPullRequestMonitorDecodeError;

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  raw: string,
  cwd: string,
  detail: string,
) =>
  Effect.sync(() => decodeJsonResult(schema)(raw)).pipe(
    Effect.flatMap((result) =>
      Result.isSuccess(result)
        ? Effect.succeed(result.success)
        : Effect.fail(
            new GitHubPullRequestMonitorDecodeError({
              command: "gh",
              cwd,
              detail,
              cause: result.failure,
            }),
          ),
    ),
  );

const actor = (value: Schema.Schema.Type<typeof ActorSchema> | null): PullRequestMonitorActor => ({
  login: value?.login ?? "ghost",
  type: value?.__typename === "Bot" ? "app" : "user",
});

const normalizeReviewState = (state: string): PullRequestMonitorReview["state"] => {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "DISMISSED":
      return "dismissed";
    case "PENDING":
      return "pending";
    default:
      return "commented";
  }
};

const normalizeCheckStatus = (status: string): PullRequestMonitorCheckRun["status"] => {
  if (status === "queued" || status === "completed") return status;
  if (status === "in_progress") return "in-progress";
  return "unknown";
};

const conclusions = new Set<NonNullable<PullRequestMonitorCheckRun["conclusion"]>>([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed-out",
  "action-required",
  "stale",
]);

export const getPullRequestMonitorSnapshot = Effect.fn("getPullRequestMonitorSnapshot")(
  function* (input: {
    readonly cwd: string;
    readonly pullRequestNumber: number;
  }): Effect.fn.Return<
    PullRequestMonitorSnapshot,
    GitHubPullRequestMonitorError,
    GitHubCli.GitHubCli
  > {
    const github = yield* GitHubCli.GitHubCli;
    const repoResult = yield* github.execute({
      cwd: input.cwd,
      args: ["repo", "view", "--json", "nameWithOwner"],
    });
    const repo = yield* decode(
      RepoSchema,
      repoResult.stdout,
      input.cwd,
      "GitHub CLI returned invalid repository JSON.",
    );
    const [owner, name] = repo.nameWithOwner.split("/");
    if (!owner || !name) {
      return yield* new GitHubPullRequestMonitorDecodeError({
        command: "gh",
        cwd: input.cwd,
        detail: "GitHub repository nameWithOwner was invalid.",
        cause: repo.nameWithOwner,
      });
    }

    const reviews = new Map<string, PullRequestMonitorReview>();
    const reviewThreads = new Map<string, PullRequestMonitorReviewThread>();
    let reviewCursor: string | null = null;
    let threadCursor: string | null = null;
    let reviewsComplete = false;
    let threadsComplete = false;
    let metadata:
      | Pick<
          PullRequestMonitorSnapshot,
          "state" | "draft" | "headSha" | "baseRefName" | "mergeability"
        >
      | undefined;
    do {
      const query = `query($owner:String!,$name:String!,$number:Int!,$reviews:String,$threads:String){repository(owner:$owner,name:$name){pullRequest(number:$number){state isDraft merged mergeable headRefOid baseRefName reviews(first:100,after:$reviews){nodes{id author{login __typename} state submittedAt commit{oid}} pageInfo{hasNextPage endCursor}} reviewThreads(first:100,after:$threads){nodes{id isResolved comments(last:1){nodes{author{login __typename} body path line createdAt updatedAt}}} pageInfo{hasNextPage endCursor}}}}}`;
      const result: VcsProcess.VcsProcessOutput = yield* github.execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${input.pullRequestNumber}`,
          ...(reviewCursor ? ["-f", `reviews=${reviewCursor}`] : []),
          ...(threadCursor ? ["-f", `threads=${threadCursor}`] : []),
        ],
      });
      const page: Schema.Schema.Type<typeof PullRequestPageSchema> = yield* decode(
        PullRequestPageSchema,
        result.stdout,
        input.cwd,
        "GitHub GraphQL returned invalid pull request monitor JSON.",
      );
      const pr: NonNullable<
        Schema.Schema.Type<typeof PullRequestPageSchema>["data"]["repository"]["pullRequest"]
      > | null = page.data.repository.pullRequest;
      if (!pr) {
        return yield* new GitHubPullRequestMonitorDecodeError({
          command: "gh",
          cwd: input.cwd,
          detail: "GitHub pull request was not found.",
          cause: input.pullRequestNumber,
        });
      }
      metadata ??= {
        state: pr.merged ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
        draft: pr.isDraft,
        headSha: pr.headRefOid,
        baseRefName: pr.baseRefName,
        mergeability:
          pr.mergeable === "MERGEABLE"
            ? "mergeable"
            : pr.mergeable === "CONFLICTING"
              ? "conflicting"
              : "unknown",
      };
      if (!reviewsComplete) {
        for (const review of pr.reviews.nodes) {
          reviews.set(review.id, {
            id: review.id,
            author: actor(review.author),
            state: normalizeReviewState(review.state),
            submittedAt: review.submittedAt,
            commitSha: review.commit?.oid ?? null,
          });
        }
        reviewsComplete = !pr.reviews.pageInfo.hasNextPage;
        reviewCursor = pr.reviews.pageInfo.endCursor;
      }
      if (!threadsComplete) {
        for (const thread of pr.reviewThreads.nodes) {
          const comment = thread.comments.nodes[0];
          if (comment) {
            reviewThreads.set(thread.id, {
              id: thread.id,
              author: actor(comment.author),
              body: comment.body,
              path: comment.path,
              line: comment.line,
              createdAt: comment.createdAt,
              updatedAt: comment.updatedAt,
              resolved: thread.isResolved,
            });
          }
        }
        threadsComplete = !pr.reviewThreads.pageInfo.hasNextPage;
        threadCursor = pr.reviewThreads.pageInfo.endCursor;
      }
    } while (!reviewsComplete || !threadsComplete);

    const issueComments: PullRequestMonitorIssueComment[] = [];
    for (let page = 1; ; page++) {
      const result = yield* github.execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "GET",
          `repos/${owner}/${name}/issues/${input.pullRequestNumber}/comments`,
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ],
      });
      const entries = yield* decode(
        IssueCommentsSchema,
        result.stdout,
        input.cwd,
        "GitHub API returned invalid issue comment JSON.",
      );
      issueComments.push(
        ...entries
          .filter((comment) => comment.user.type === "Bot")
          .map((comment) => ({
            id: String(comment.id),
            author: { login: comment.user.login, type: "app" as const },
            body: comment.body,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
          })),
      );
      if (entries.length < 100) break;
    }

    const checkRuns: PullRequestMonitorCheckRun[] = [];
    for (let page = 1; ; page++) {
      const result = yield* github.execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "GET",
          `repos/${owner}/${name}/commits/${metadata.headSha}/check-runs`,
          "-H",
          "Accept: application/vnd.github+json",
          "-f",
          "per_page=100",
          "-f",
          `page=${page}`,
        ],
      });
      const response = yield* decode(
        CheckRunsSchema,
        result.stdout,
        input.cwd,
        "GitHub API returned invalid check run JSON.",
      );
      checkRuns.push(
        ...response.check_runs.map((check) => ({
          id: String(check.id),
          name: check.name,
          status: normalizeCheckStatus(check.status),
          conclusion:
            check.conclusion && conclusions.has(check.conclusion as never)
              ? (check.conclusion as PullRequestMonitorCheckRun["conclusion"])
              : null,
          startedAt: check.started_at,
          headSha: check.head_sha,
        })),
      );
      if (response.check_runs.length < 100) break;
    }

    return {
      ...metadata,
      behindBaseBy: null,
      requiredChecksKnown: false,
      reviews: [...reviews.values()],
      reviewThreads: [...reviewThreads.values()],
      issueComments,
      checkRuns,
    };
  },
);
