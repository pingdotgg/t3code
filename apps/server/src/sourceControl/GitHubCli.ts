import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";

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

export class GitHubPullRequestDetailDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestDetailDecodeError>()(
  "GitHubPullRequestDetailDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request detail JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequestDetail: ${this.detail}`;
  }
}

export class GitHubPullRequestChecksDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestChecksDecodeError>()(
  "GitHubPullRequestChecksDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request checks JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listPullRequestChecks: ${this.detail}`;
  }
}

export class GitHubPullRequestReviewsDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestReviewsDecodeError>()(
  "GitHubPullRequestReviewsDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request reviews JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listPullRequestReviews: ${this.detail}`;
  }
}

export class GitHubPullRequestReviewCommentsDecodeError extends Schema.TaggedErrorClass<GitHubPullRequestReviewCommentsDecodeError>()(
  "GitHubPullRequestReviewCommentsDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request review comments JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listPullRequestReviewComments: ${this.detail}`;
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
  GitHubPullRequestDetailDecodeError,
  GitHubPullRequestChecksDecodeError,
  GitHubPullRequestReviewsDecodeError,
  GitHubPullRequestReviewCommentsDecodeError,
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
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export type GitHubMergeStrategy = "squash" | "merge" | "rebase";

export interface GitHubPullRequestDetail {
  readonly state: string;
  readonly mergedAt: string | null;
  readonly reviewDecision: string | null;
  readonly headRefOid: string;
  readonly url: string;
}

export interface GitHubPullRequestCheck {
  readonly name: string;
  readonly state: string;
  readonly bucket: string;
  readonly link: string;
}

export interface GitHubPullRequestReview {
  readonly id: string;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface GitHubPullRequestReviewComment {
  readonly id: number;
  readonly user: string;
  readonly body: string;
  readonly path: string | null;
  readonly createdAt: string;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

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
      readonly draft?: boolean;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly mergePullRequest: (input: {
      readonly cwd: string;
      readonly number: number;
      readonly strategy: GitHubMergeStrategy;
    }) => Effect.Effect<void, GitHubCliError>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestDetail, GitHubCliError>;

    readonly listPullRequestChecks: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestCheck>, GitHubCliError>;

    readonly listPullRequestReviews: (input: {
      readonly cwd: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReview>, GitHubCliError>;

    readonly listPullRequestReviewComments: (input: {
      readonly cwd: string;
      readonly repo: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestReviewComment>, GitHubCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
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

const RawGitHubPullRequestDetailSchema = Schema.Struct({
  state: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  reviewDecision: Schema.NullOr(Schema.String),
  headRefOid: Schema.String,
  url: Schema.String,
});
const decodeRawGitHubPullRequestDetail = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubPullRequestDetailSchema),
);

const RawGitHubPullRequestCheckSchema = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  bucket: Schema.optional(Schema.NullOr(Schema.String)),
  link: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawGitHubPullRequestChecksSchema = Schema.Array(RawGitHubPullRequestCheckSchema);
const decodeRawGitHubPullRequestChecks = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubPullRequestChecksSchema),
);

const RawGitHubPullRequestReviewsSchema = Schema.Struct({
  reviews: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.NullOr(Schema.String)),
      author: Schema.optional(
        Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
      ),
      state: Schema.optional(Schema.NullOr(Schema.String)),
      body: Schema.optional(Schema.NullOr(Schema.String)),
      submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeRawGitHubPullRequestReviews = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubPullRequestReviewsSchema),
);

const RawGitHubPullRequestReviewCommentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
    body: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.optional(Schema.NullOr(Schema.String)),
    created_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeRawGitHubPullRequestReviewComments = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubPullRequestReviewCommentsSchema),
);

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
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

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
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
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
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
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
          ...(input.draft ? ["--draft"] : []),
        ],
      }).pipe(Effect.asVoid),
    mergePullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "merge",
          String(input.number),
          input.strategy === "merge"
            ? "--merge"
            : input.strategy === "rebase"
              ? "--rebase"
              : "--squash",
        ],
      }).pipe(Effect.asVoid),
    getPullRequestDetail: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          String(input.number),
          "--json",
          "state,mergedAt,reviewDecision,headRefOid,url",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubPullRequestDetail(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubPullRequestDetailDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((raw) => ({
          state: raw.state,
          mergedAt: raw.mergedAt,
          reviewDecision: raw.reviewDecision,
          headRefOid: raw.headRefOid,
          url: raw.url,
        })),
      ),
    listPullRequestChecks: (input) =>
      // `gh pr checks` exits 8 while checks are pending and 1 when some fail,
      // yet still prints valid JSON. Tolerate those exit codes (and 0) as long
      // as stdout parses; any other exit code is a real failure.
      process
        .run({
          operation: "GitHubCli.execute",
          command: "gh",
          args: ["pr", "checks", String(input.number), "--json", "name,state,bucket,link"],
          cwd: input.cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)),
          Effect.flatMap((result): Effect.Effect<ReadonlyArray<GitHubPullRequestCheck>, GitHubCliError> => {
            const exitCode = result.exitCode as number;
            if (exitCode !== 0 && exitCode !== 1 && exitCode !== 8) {
              return Effect.fail(
                new GitHubCliCommandError({
                  command: "gh",
                  cwd: input.cwd,
                  cause: new Error(
                    result.stderr.trim() || `gh pr checks exited with code ${exitCode}.`,
                  ),
                }),
              );
            }
            const raw = result.stdout.trim();
            if (raw.length === 0) {
              return Effect.succeed([] as ReadonlyArray<GitHubPullRequestCheck>);
            }
            return decodeRawGitHubPullRequestChecks(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubPullRequestChecksDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause,
                  }),
              ),
              Effect.map((checks) =>
                checks.map((check) => ({
                  name: check.name ?? "",
                  state: check.state ?? "",
                  bucket: check.bucket ?? "",
                  link: check.link ?? "",
                })),
              ),
            );
          }),
        ),
    listPullRequestReviews: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", String(input.number), "--json", "reviews"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubPullRequestReviews(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubPullRequestReviewsDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((decoded) =>
          decoded.reviews.map((review) => ({
            id: review.id ?? "",
            author: review.author?.login ?? "",
            state: review.state ?? "",
            body: review.body ?? "",
            submittedAt: review.submittedAt ?? "",
          })),
        ),
      ),
    listPullRequestReviewComments: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `repos/${input.repo}/pulls/${input.number}/comments`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubPullRequestReviewComments(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubPullRequestReviewCommentsDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((decoded) =>
          decoded.map((comment) => ({
            id: comment.id,
            user: comment.user?.login ?? "",
            body: comment.body ?? "",
            path: comment.path ?? null,
            createdAt: comment.created_at ?? "",
          })),
        ),
      ),
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
  });
});

export const layer = Layer.effect(GitHubCli, make);
