import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type PullRequestReviewResult,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";
import { decodeGitHubPullRequestReviewJson } from "./gitHubPullRequestReview.ts";
import {
  parsePullRequestReviewStatus,
  type PullRequestReviewLifecycle,
} from "./pullRequestReviewLifecycle.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedErrorClass<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedErrorClass<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedErrorClass<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedErrorClass<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedErrorClass<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export class GitHubPullRequestReviewDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestReviewDecodeError>()(
  "GitHubPullRequestReviewDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request review JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestReview: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
  GitHubPullRequestReviewDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly headRefOid?: string | null;
}

export interface GitHubPullRequestIssueComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorLogin: string;
}

export type GitHubPullRequestReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

export interface GitHubPullRequestReviewCommentInput {
  readonly path: string;
  readonly body: string;
  readonly line?: number | null;
  readonly side?: "LEFT" | "RIGHT" | null;
}

export interface GitHubSubmitPullRequestReviewResult {
  readonly reviewId: string;
  readonly url: string;
}

export type GitHubPullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export interface GitHubPullRequestReviewStatus {
  readonly reviewDecision: GitHubPullRequestReviewDecision | null;
  readonly unresolvedReviewThreadCount: number | null;
  readonly actionableReviewItemCount?: number | null;
  /** Where the PR sits in its review lifecycle; absent when unknown. */
  readonly reviewLifecycle?: PullRequestReviewLifecycle | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly stdin?: string;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    /**
     * List open PRs for the repository at `cwd` (not filtered by head branch).
     * Includes `headRefOid` for auto-review idempotency.
     */
    readonly listRepositoryOpenPullRequests: (input: {
      readonly cwd: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly listPullRequestIssueComments: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestIssueComment>, GitHubCliError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<string, GitHubCliError>;

    readonly submitPullRequestReview: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly commitId: string;
      readonly body: string;
      readonly event: GitHubPullRequestReviewEvent;
      readonly comments?: ReadonlyArray<GitHubPullRequestReviewCommentInput>;
    }) => Effect.Effect<GitHubSubmitPullRequestReviewResult, GitHubCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getPullRequestReviewStatus: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitHubPullRequestReviewStatus, GitHubCliError>;

    readonly getPullRequestReview: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<PullRequestReviewResult, GitHubCliError>;

    readonly mergePullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly markPullRequestReady: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

const RawGitHubReviewDecisionSchema = Schema.Struct({
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawGitHubReviewDecision = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubReviewDecisionSchema),
);

const RawGitHubNameWithOwnerSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
});
const decodeRawGitHubNameWithOwner = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubNameWithOwnerSchema),
);

function normalizeReviewDecision(
  value: string | null | undefined,
): GitHubPullRequestReviewDecision | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (normalized === "APPROVED") return "APPROVED";
  if (normalized === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  if (normalized === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
  return null;
}

function parsePullRequestNumber(reference: string): number | null {
  const trimmed = reference.trim();
  const hashMatch = /^#?(\d+)$/.exec(trimmed);
  if (hashMatch?.[1]) {
    const number = Number(hashMatch[1]);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  const urlMatch = /\/pull\/(\d+)(?:\/|$)/i.exec(trimmed);
  if (urlMatch?.[1]) {
    const number = Number(urlMatch[1]);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  return null;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: GitHubCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  const decodePullRequestList = (input: { readonly cwd: string; readonly raw: string }) =>
    input.raw.length === 0
      ? Effect.succeed([] as ReadonlyArray<GitHubPullRequestSummary>)
      : Effect.sync(() => decodeGitHubPullRequestListJson(input.raw)).pipe(
          Effect.flatMap((decoded) => {
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new GitHubPullRequestListDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause: decoded.failure,
                }),
              );
            }

            return Effect.succeed(
              decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
            );
          }),
        );

  const prListJsonFields =
    "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner";

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          prListJsonFields,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) => decodePullRequestList({ cwd: input.cwd, raw })),
      ),
    listRepositoryOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 50),
          "--json",
          prListJsonFields,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) => decodePullRequestList({ cwd: input.cwd, raw })),
      ),
    listPullRequestIssueComments: (input) =>
      Effect.gen(function* () {
        const limit = input.limit ?? 50;
        const raw = yield* execute({
          cwd: input.cwd,
          args: ["pr", "view", input.reference, "--json", "comments"],
        }).pipe(Effect.map((result) => result.stdout.trim() || "{}"));

        const RawCommentsSchema = Schema.Struct({
          comments: Schema.Array(
            Schema.Struct({
              id: Schema.Union([Schema.String, Schema.Number]),
              body: Schema.String,
              createdAt: Schema.String,
              author: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    login: Schema.optional(Schema.String),
                  }),
                ),
              ),
            }),
          ),
        });
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RawCommentsSchema))(
          raw,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubCliCommandError({
                command: "gh",
                cwd: input.cwd,
                cause,
              }),
          ),
        );

        return decoded.comments.slice(0, limit).map(
          (comment): GitHubPullRequestIssueComment => ({
            id: String(comment.id),
            body: comment.body,
            createdAt: comment.createdAt,
            authorLogin: comment.author?.login?.trim() || "ghost",
          }),
        );
      }),
    getPullRequestDiff: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "diff", input.reference],
      }).pipe(Effect.map((result) => result.stdout)),
    submitPullRequestReview: (input) =>
      Effect.gen(function* () {
        const prNumber = parsePullRequestNumber(input.reference);
        if (prNumber === null) {
          return yield* new GitHubPullRequestNotFoundError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("Pull request reference does not contain a number."),
          });
        }

        const comments = (input.comments ?? [])
          .filter((comment) => comment.path.trim().length > 0 && comment.body.trim().length > 0)
          .map((comment) => {
            const line =
              comment.line !== undefined &&
              comment.line !== null &&
              Number.isSafeInteger(comment.line) &&
              comment.line > 0
                ? comment.line
                : undefined;
            const side = comment.side === "LEFT" || comment.side === "RIGHT" ? comment.side : undefined;
            return {
              path: comment.path,
              body: comment.body,
              ...(line !== undefined ? { line } : {}),
              ...(side !== undefined ? { side } : {}),
            };
          });

        const payload = {
          commit_id: input.commitId,
          body: input.body,
          event: input.event,
          ...(comments.length > 0 ? { comments } : {}),
        };

        const raw = yield* execute({
          cwd: input.cwd,
          args: [
            "api",
            "--method",
            "POST",
            `repos/{owner}/{repo}/pulls/${prNumber}/reviews`,
            "--input",
            "-",
          ],
          stdin: yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(payload).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubCliCommandError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        }).pipe(Effect.map((result) => result.stdout.trim() || "{}"));

        const ReviewResponseSchema = Schema.Struct({
          id: Schema.Union([Schema.Number, Schema.String]),
          html_url: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
        });
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ReviewResponseSchema),
        )(raw).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubCliCommandError({
                command: "gh",
                cwd: input.cwd,
                cause,
              }),
          ),
        );

        return {
          reviewId: String(decoded.id),
          url: decoded.html_url?.trim() || decoded.url?.trim() || "",
        } satisfies GitHubSubmitPullRequestReviewResult;
      }),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          prListJsonFields,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(
                (({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success),
              );
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    getPullRequestReviewStatus: (input) =>
      Effect.gen(function* () {
        // Best-effort: a failed decision or thread lookup must not fail status.
        // Callers treat nulls as "not ready / unknown".
        const reviewDecision = yield* execute({
          cwd: input.cwd,
          args: ["pr", "view", input.reference, "--json", "reviewDecision"],
        }).pipe(
          Effect.flatMap((result) =>
            decodeRawGitHubReviewDecision(result.stdout.trim() || "{}").pipe(
              Effect.map((raw) => normalizeReviewDecision(raw.reviewDecision)),
            ),
          ),
          Effect.orElseSucceed(() => null),
        );

        const unknownReviewStatus = {
          reviewDecision,
          unresolvedReviewThreadCount: null,
          actionableReviewItemCount: null,
          reviewLifecycle: null,
        };

        const prNumber = parsePullRequestNumber(input.reference);
        if (prNumber === null) {
          return unknownReviewStatus;
        }

        const nameWithOwner = yield* execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "nameWithOwner"],
        }).pipe(
          Effect.flatMap((result) =>
            decodeRawGitHubNameWithOwner(result.stdout.trim() || "{}").pipe(
              Effect.map((raw) => raw.nameWithOwner),
            ),
          ),
          Effect.orElseSucceed(() => null),
        );
        if (!nameWithOwner) {
          return unknownReviewStatus;
        }

        const [owner, name] = nameWithOwner.split("/", 2);
        if (!owner || !name) {
          return unknownReviewStatus;
        }

        // Review bodies are big (bot walkthroughs), and this runs on the
        // polled status path, so only comments carry bodies: the lifecycle
        // markers live there. Reviews are fetched for their state alone, to
        // tell "reviewed and clean" from "not reviewed yet". A bot edits its
        // summary comment in place, so both ends of the comment list are
        // sampled — the summary stays first, the re-review chatter lands last.
        const graphqlQuery =
          "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { isResolved isOutdated comments(first: 1) { nodes { body } } } pageInfo { hasNextPage } } reviews(last: 5) { nodes { state } } firstComments: comments(first: 5) { nodes { author { login } body } } latestComments: comments(last: 5) { nodes { author { login } body } } } } }";

        const reviewStatus = yield* execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "-f",
            `query=${graphqlQuery}`,
            "-F",
            `owner=${owner}`,
            "-F",
            `name=${name}`,
            "-F",
            `number=${prNumber}`,
          ],
        }).pipe(
          Effect.map((result) => parsePullRequestReviewStatus(result.stdout.trim() || "{}")),
          Effect.orElseSucceed(() => ({
            unresolvedReviewThreadCount: null,
            actionableReviewItemCount: null,
            reviewLifecycle: null,
          })),
        );

        return { reviewDecision, ...reviewStatus };
      }),
    getPullRequestReview: (input) =>
      Effect.gen(function* () {
        const prNumber = parsePullRequestNumber(input.reference);
        if (prNumber === null) {
          return yield* new GitHubPullRequestNotFoundError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("Pull request reference does not contain a number."),
          });
        }

        const repositoryResult = yield* execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "nameWithOwner"],
        });
        const nameWithOwner = yield* decodeRawGitHubNameWithOwner(
          repositoryResult.stdout.trim() || "{}",
        ).pipe(
          Effect.map((raw) => raw.nameWithOwner),
          Effect.mapError(
            (cause) => new GitHubRepositoryDecodeError({ command: "gh", cwd: input.cwd, cause }),
          ),
        );
        const [owner, name] = nameWithOwner.split("/", 2);
        if (!owner || !name) {
          return yield* new GitHubRepositoryDecodeError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error("Repository nameWithOwner is malformed."),
          });
        }

        const graphqlQuery =
          "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { number url comments(first: 100) { nodes { id author { __typename login avatarUrl } authorAssociation body url createdAt updatedAt } pageInfo { hasNextPage } } reviews(first: 100) { nodes { id author { __typename login avatarUrl } authorAssociation body url createdAt updatedAt state } pageInfo { hasNextPage } } reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine diffSide comments(first: 100) { nodes { id author { __typename login avatarUrl } authorAssociation body url createdAt updatedAt } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }";

        const result = yield* execute({
          cwd: input.cwd,
          args: [
            "api",
            "graphql",
            "-f",
            `query=${graphqlQuery}`,
            "-F",
            `owner=${owner}`,
            "-F",
            `name=${name}`,
            "-F",
            `number=${prNumber}`,
          ],
        });

        return yield* Effect.sync(() =>
          decodeGitHubPullRequestReviewJson(result.stdout.trim() || "{}"),
        ).pipe(
          Effect.flatMap((decoded) =>
            Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  new GitHubPullRequestReviewDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                ),
          ),
        );
      }),
    mergePullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "merge", input.reference, "--merge"],
      }).pipe(Effect.asVoid),
    markPullRequestReady: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "ready", input.reference],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make);
