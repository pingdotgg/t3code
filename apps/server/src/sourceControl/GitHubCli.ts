import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type ChangeRequestState,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
} from "./gitHubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const BASE_REPOSITORY_CACHE_CAPACITY = 2_048;
const BASE_REPOSITORY_CACHE_TTL = Duration.seconds(5);

interface PullRequestRepositoryContext {
  readonly baseRepository: string;
  readonly headRepository: string;
}

interface GitHubRepositoryCoordinate {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

function parseGitHubRepositoryCoordinate(
  repository: string,
): GitHubRepositoryCoordinate | undefined {
  const parts = repository.split("/").filter((part) => part.length > 0);
  if (parts.length !== 3) return undefined;
  const [host, owner, name] = parts;
  return host && owner && name ? { host, owner, name } : undefined;
}

function ownerLoginFromRepository(repository: string): string | undefined {
  const parts = repository.split("/").filter((part) => part.length > 0);
  if (parts.length >= 3) {
    return parts[parts.length - 2];
  }
  if (parts.length === 2) {
    return parts[0];
  }
  return undefined;
}

function qualifyPullRequestHead(
  context: PullRequestRepositoryContext,
  headSelector: string,
): string {
  if (
    context.baseRepository.toLowerCase() === context.headRepository.toLowerCase() ||
    /^[^:\s]+:.+$/u.test(headSelector)
  ) {
    return headSelector;
  }

  const owner = ownerLoginFromRepository(context.headRepository);
  return owner ? `${owner}:${headSelector}` : headSelector;
}

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

export class GitHubRepositoryContextDecodeError extends Schema.TaggedErrorClass<GitHubRepositoryContextDecodeError>()(
  "GitHubRepositoryContextDecodeError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request repository context.";
  }

  override get message(): string {
    return `GitHub CLI failed in resolvePullRequestRepositoryContext: ${this.detail}`;
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
    return `GitHub CLI failed in listPullRequests: ${this.detail}`;
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

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubRepositoryContextDecodeError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
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
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
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
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly state: ChangeRequestState | "all";
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

    readonly getPullRequestBaseRepositoryCloneUrls: (input: {
      readonly cwd: string;
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

  const pullRequestRepositoryContextCache = yield* Cache.makeWith(
    (cwd: string) =>
      execute({
        cwd,
        args: [
          "repo",
          "view",
          "--json",
          "nameWithOwner,parent,url",
          "--jq",
          '. as $repo | (.url | capture("^https?://(?<host>[^/]+)").host) as $host | [if $repo.parent then "\\($host)/\\($repo.parent.owner.login)/\\($repo.parent.name)" else "\\($host)/\\($repo.nameWithOwner)" end, "\\($host)/\\($repo.nameWithOwner)"] | @tsv',
        ],
      }).pipe(
        Effect.flatMap((result) => {
          const [baseRepository, headRepository] = result.stdout.trim().split("\t");
          if (baseRepository && headRepository) {
            return Effect.succeed({ baseRepository, headRepository });
          }
          return Effect.fail(
            new GitHubRepositoryContextDecodeError({
              command: "gh",
              cwd,
            }),
          );
        }),
      ),
    {
      capacity: BASE_REPOSITORY_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? BASE_REPOSITORY_CACHE_TTL : Duration.zero),
    },
  );

  const resolvePullRequestRepositoryContext = (cwd: string) =>
    Cache.get(pullRequestRepositoryContextCache, cwd);

  const getRepositoryCloneUrls: GitHubCli["Service"]["getRepositoryCloneUrls"] = (input) =>
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
    );

  return GitHubCli.of({
    execute,
    listPullRequests: (input) =>
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "list",
              "--head",
              input.headSelector,
              "--state",
              input.state,
              "--limit",
              String(input.limit ?? (input.state === "open" ? 1 : 20)),
              "--repo",
              context.baseRepository,
              "--json",
              "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
            ],
          }),
        ),
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

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "view",
              input.reference,
              "--repo",
              context.baseRepository,
              "--json",
              "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
            ],
          }),
        ),
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
    getRepositoryCloneUrls,
    getPullRequestBaseRepositoryCloneUrls: (input) =>
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) =>
          getRepositoryCloneUrls({ cwd: input.cwd, repository: context.baseRepository }),
        ),
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
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) => {
          const base = parseGitHubRepositoryCoordinate(context.baseRepository);
          const head = parseGitHubRepositoryCoordinate(context.headRepository);
          if (
            base &&
            head &&
            context.baseRepository.toLowerCase() !== context.headRepository.toLowerCase()
          ) {
            const qualifiedHead = qualifyPullRequestHead(context, input.headSelector);
            const separatorIndex = qualifiedHead.indexOf(":");
            const headBranch =
              separatorIndex >= 0 ? qualifiedHead.slice(separatorIndex + 1) : qualifiedHead;
            return execute({
              cwd: input.cwd,
              args: [
                "api",
                "--hostname",
                base.host,
                `repos/${base.owner}/${base.name}/pulls`,
                "--method",
                "POST",
                "-f",
                `title=${input.title}`,
                "-f",
                `head=${head.owner}:${headBranch}`,
                "-f",
                `head_repo=${head.name}`,
                "-f",
                `base=${input.baseBranch}`,
                "-F",
                `body=@${input.bodyFile}`,
                "--silent",
              ],
            });
          }

          return execute({
            cwd: input.cwd,
            args: [
              "pr",
              "create",
              "--base",
              input.baseBranch,
              "--head",
              qualifyPullRequestHead(context, input.headSelector),
              "--title",
              input.title,
              "--body-file",
              input.bodyFile,
              "--repo",
              context.baseRepository,
            ],
          });
        }),
        Effect.asVoid,
      ),
    getDefaultBranch: (input) =>
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) =>
          execute({
            cwd: input.cwd,
            args: [
              "repo",
              "view",
              context.baseRepository,
              "--json",
              "defaultBranchRef",
              "--jq",
              ".defaultBranchRef.name",
            ],
          }),
        ),
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      resolvePullRequestRepositoryContext(input.cwd).pipe(
        Effect.flatMap((context) =>
          execute({
            cwd: input.cwd,
            args: [
              "pr",
              "checkout",
              input.reference,
              ...(input.force ? ["--force"] : []),
              "--repo",
              context.baseRepository,
            ],
          }),
        ),
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(GitHubCli, make);
