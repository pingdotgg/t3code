import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type GitHubAccountSelection,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
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

export class GitHubCredentialError extends Schema.TaggedErrorClass<GitHubCredentialError>()(
  "GitHubCredentialError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    host: Schema.String,
    reason: GitHubCredentials.GitHubCredentialReason,
  },
) {
  get detail(): string {
    switch (this.reason._tag) {
      case "SettingsUnavailable":
        return `GitHub account settings could not be loaded for ${this.host}.`;
      case "SelectionConflict":
        return `Repositories on ${this.host} require different GitHub accounts: ${this.reason.repositories.join(", ")}.`;
      case "HostMismatch":
        return `GitHub account ${this.reason.login} belongs to ${this.reason.accountHost}, not ${this.host}.`;
      case "TokenUnavailable":
        return this.reason.kind === "env-missing"
          ? `GitHub token source ${this.reason.tokenSource} is unavailable for ${this.reason.login} on ${this.host}.`
          : `GitHub CLI returned no token for ${this.reason.login} on ${this.host}.`;
    }
  }

  override get message(): string {
    return `GitHub CLI credential selection failed: ${this.detail}`;
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

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubPullRequestNotFoundError,
  GitHubCliCommandError,
  GitHubCredentialError,
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
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

type GitHubAuthTarget = GitHubCredentials.GitHubCredentialTarget;

const GITHUB_TOKEN_ENV_SOURCES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

function definedAuthTarget(input: GitHubAuthTarget): GitHubAuthTarget {
  return {
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
  };
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly host?: string;
      readonly repositories?: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      /** Piped to the child's stdin, for payloads that must never appear in argv. */
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    /** Stable, non-secret identity for the credential that will serve this target. */
    readonly getBatchKey: (
      input: GitHubAuthTarget & { readonly cwd: string },
    ) => Effect.Effect<string, GitHubCliError>;

    readonly listOpenPullRequests: (
      input: {
        readonly cwd: string;
        readonly headSelector: string;
        readonly limit?: number;
      } & GitHubAuthTarget,
    ) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly getPullRequest: (
      input: {
        readonly cwd: string;
        readonly reference: string;
      } & GitHubAuthTarget,
    ) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (
      input: {
        readonly cwd: string;
        readonly repository: string;
      } & GitHubAuthTarget,
    ) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (
      input: {
        readonly cwd: string;
        readonly repository: string;
        readonly visibility: SourceControlRepositoryVisibility;
      } & GitHubAuthTarget,
    ) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (
      input: {
        readonly cwd: string;
        readonly baseBranch: string;
        readonly headSelector: string;
        readonly title: string;
        readonly bodyFile: string;
      } & GitHubAuthTarget,
    ) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (
      input: {
        readonly cwd: string;
      } & GitHubAuthTarget,
    ) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (
      input: {
        readonly cwd: string;
        readonly reference: string;
        readonly force?: boolean;
      } & GitHubAuthTarget,
    ) => Effect.Effect<void, GitHubCliError>;
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
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const settings = yield* ServerSettings.ServerSettingsService;

  const credentialRoute = Effect.fn("GitHubCli.credentialRoute")(function* (
    input: GitHubAuthTarget & { readonly cwd: string },
  ): Effect.fn.Return<GitHubCredentials.GitHubCredentialRoute, GitHubCliError> {
    const host = (input.host ?? "github.com").toLowerCase();
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new GitHubCredentialError({
            command: "gh",
            cwd: input.cwd,
            host,
            reason: { _tag: "SettingsUnavailable", cause },
          }),
      ),
    );
    const selected = GitHubCredentials.selectCredentialRoute(current, input);
    if (Result.isFailure(selected)) {
      return yield* new GitHubCredentialError({
        command: "gh",
        cwd: input.cwd,
        host,
        reason: selected.failure,
      });
    }
    return selected.success;
  });

  const tokenFor = Effect.fn("GitHubCli.tokenFor")(function* (input: {
    readonly account: GitHubAccountSelection;
    readonly cwd: string;
  }) {
    if (GITHUB_TOKEN_ENV_SOURCES.has(input.account.tokenSource)) {
      const token = process.env[input.account.tokenSource]?.trim();
      if (token !== undefined && token.length > 0) return token;
      return yield* new GitHubCredentialError({
        command: "gh",
        cwd: input.cwd,
        host: input.account.host,
        reason: {
          _tag: "TokenUnavailable",
          login: input.account.login,
          tokenSource: input.account.tokenSource,
          kind: "env-missing",
        },
      });
    }

    const output = yield* vcsProcess
      .run({
        operation: "GitHubCli.authToken",
        command: "gh",
        args: ["auth", "token", "--hostname", input.account.host, "--user", input.account.login],
        cwd: input.cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));
    const token = output.stdout.trim();
    if (token.length === 0) {
      return yield* new GitHubCredentialError({
        command: "gh",
        cwd: input.cwd,
        host: input.account.host,
        reason: {
          _tag: "TokenUnavailable",
          login: input.account.login,
          tokenSource: input.account.tokenSource,
          kind: "empty-output",
        },
      });
    }
    return token;
  });

  const run = (input: Parameters<GitHubCli["Service"]["execute"]>[0], env?: NodeJS.ProcessEnv) =>
    vcsProcess
      .run({
        operation: "GitHubCli.execute",
        command: "gh",
        args: input.args,
        cwd: input.cwd,
        ...(env !== undefined ? { env } : {}),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));

  const execute: GitHubCli["Service"]["execute"] = Effect.fn("GitHubCli.execute")(
    function* (input) {
      const route = yield* credentialRoute(input);
      if (route.account === undefined) return yield* run(input);

      const token = yield* tokenFor({ account: route.account, cwd: input.cwd });
      const tokenVariable =
        route.host === "github.com" || route.host.endsWith(".ghe.com")
          ? "GH_TOKEN"
          : "GH_ENTERPRISE_TOKEN";
      return yield* run(input, { [tokenVariable]: token });
    },
  );

  return GitHubCli.of({
    execute,
    getBatchKey: (input) => credentialRoute(input).pipe(Effect.map((route) => route.key)),
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        ...definedAuthTarget(input),
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
        ...definedAuthTarget(input),
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
        ...definedAuthTarget(input),
        repositories: [input.repository],
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
        ...definedAuthTarget(input),
        repositories: [input.repository],
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        ...definedAuthTarget(input),
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
        ...definedAuthTarget(input),
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
        ...definedAuthTarget(input),
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make);
