import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeGitLabMergeRequestJson,
  decodeGitLabMergeRequestListJson,
} from "./gitLabMergeRequests.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const gitLabCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("glab"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const gitLabCliDecodeErrorContext = {
  command: Schema.Literal("glab"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class GitLabCliUnavailableError extends Schema.TaggedErrorClass<GitLabCliUnavailableError>()(
  "GitLabCliUnavailableError",
  gitLabCliExecutionErrorContext,
) {
  get detail(): string {
    return "GitLab CLI (`glab`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabCliAuthenticationError extends Schema.TaggedErrorClass<GitLabCliAuthenticationError>()(
  "GitLabCliAuthenticationError",
  gitLabCliExecutionErrorContext,
) {
  get detail(): string {
    return "GitLab CLI is not authenticated. Run `glab auth login` and retry.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabMergeRequestNotFoundError extends Schema.TaggedErrorClass<GitLabMergeRequestNotFoundError>()(
  "GitLabMergeRequestNotFoundError",
  {
    ...gitLabCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Merge request ${this.reference} was not found. Check the MR number or URL and try again.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "glab";
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): GitLabCliError {
    if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
      return new GitLabMergeRequestNotFoundError({ ...context, cause: error });
    }

    return GitLabCliCommandError.fromVcsError(
      {
        operation: context.operation,
        command: context.command,
        cwd: context.cwd,
      },
      error,
    );
  }
}

export class GitLabCliCommandError extends Schema.TaggedErrorClass<GitLabCliCommandError>()(
  "GitLabCliCommandError",
  gitLabCliExecutionErrorContext,
) {
  get detail(): string {
    return "GitLab CLI command failed.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "glab";
      readonly cwd: string;
    },
    error: VcsError,
  ): GitLabCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => new GitLabCliUnavailableError({ ...context, cause }),
      VcsProcessExitError: (cause) => {
        switch (cause.failureKind) {
          case "authentication":
            return new GitLabCliAuthenticationError({ ...context, cause });
          case "not-found":
          case "command-failed":
          case undefined:
            return new GitLabCliCommandError({ ...context, cause });
        }
      },
      VcsProcessTimeoutError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new GitLabCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new GitLabCliCommandError({ ...context, cause }),
    });
  }
}

export class GitLabMergeRequestListDecodeError extends Schema.TaggedErrorClass<GitLabMergeRequestListDecodeError>()(
  "GitLabMergeRequestListDecodeError",
  {
    ...gitLabCliDecodeErrorContext,
    operation: Schema.Literal("listMergeRequests"),
  },
) {
  get detail(): string {
    return "GitLab CLI returned invalid MR list JSON.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabMergeRequestDecodeError extends Schema.TaggedErrorClass<GitLabMergeRequestDecodeError>()(
  "GitLabMergeRequestDecodeError",
  {
    ...gitLabCliDecodeErrorContext,
    operation: Schema.Literal("getMergeRequest"),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned invalid merge request JSON.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabRepositoryDecodeError extends Schema.TaggedErrorClass<GitLabRepositoryDecodeError>()(
  "GitLabRepositoryDecodeError",
  {
    ...gitLabCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository", "getDefaultBranch"]),
    repository: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "GitLab CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabNamespaceDecodeError extends Schema.TaggedErrorClass<GitLabNamespaceDecodeError>()(
  "GitLabNamespaceDecodeError",
  {
    ...gitLabCliDecodeErrorContext,
    operation: Schema.Literal("createRepository"),
    namespacePath: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned invalid namespace JSON.";
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const GitLabCliError = Schema.Union([
  GitLabCliUnavailableError,
  GitLabCliAuthenticationError,
  GitLabMergeRequestNotFoundError,
  GitLabCliCommandError,
  GitLabMergeRequestListDecodeError,
  GitLabMergeRequestDecodeError,
  GitLabRepositoryDecodeError,
  GitLabNamespaceDecodeError,
]);
export type GitLabCliError = typeof GitLabCliError.Type;
export const isGitLabCliError = Schema.is(GitLabCliError);

export interface GitLabMergeRequestSummary {
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

export interface GitLabRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GitLabCli extends Context.Service<
  GitLabCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GitLabCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GitLabMergeRequestSummary>, GitLabCliError>;

    readonly getMergeRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GitLabMergeRequestSummary, GitLabCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;

    readonly createMergeRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GitLabCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GitLabCliError>;

    readonly checkoutMergeRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GitLabCliError>;
  }
>()("t3/sourceControl/GitLabCli") {}

const RawGitLabRepositoryCloneUrlsSchema = Schema.Struct({
  path_with_namespace: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  http_url_to_repo: TrimmedNonEmptyString,
  ssh_url_to_repo: TrimmedNonEmptyString,
});

const RawGitLabDefaultBranchSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const RawGitLabNamespaceSchema = Schema.Struct({
  id: Schema.Number,
});

const decodeGitLabRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitLabRepositoryCloneUrlsSchema),
);
const decodeGitLabDefaultBranch = Schema.decodeEffect(
  Schema.fromJsonString(RawGitLabDefaultBranchSchema),
);
const decodeGitLabNamespace = Schema.decodeEffect(Schema.fromJsonString(RawGitLabNamespaceSchema));

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitLabRepositoryCloneUrlsSchema>,
): GitLabRepositoryCloneUrls {
  return {
    nameWithOwner: raw.path_with_namespace,
    url: raw.web_url,
    sshUrl: raw.ssh_url_to_repo,
  };
}

function stateArgs(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return [];
    case "closed":
      return ["--closed"];
    case "merged":
      return ["--merged"];
    case "all":
      return ["--all"];
  }
}

function normalizeHeadSelector(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerBranch = /^[^:]+:(.+)$/.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

function sourceProjectIdentifier(
  source: SourceControlProvider.SourceControlRefSelector | undefined,
): string | null {
  return source?.repository ?? source?.owner ?? null;
}

function toSummaryWithOptionalUpdatedAt(
  record: GitLabMergeRequestSummary & {
    readonly updatedAt: Option.Option<DateTime.Utc>;
  },
): GitLabMergeRequestSummary {
  const { updatedAt, ...summary } = record;
  return Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

function parseRepositoryPath(repository: string): {
  readonly namespacePath: string | null;
  readonly projectPath: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  const projectPath = parts.at(-1) ?? repository.trim();
  const namespacePath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { namespacePath, projectPath };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const run = (
    input: Parameters<GitLabCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => GitLabCliError,
  ) =>
    process
      .run({
        operation: "GitLabCli.execute",
        command: "glab",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError(mapError));

  const execute: GitLabCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      GitLabCliCommandError.fromVcsError(
        { operation: "execute", command: "glab", cwd: input.cwd },
        error,
      ),
    );

  const executeMergeRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    run(input, (error) =>
      GitLabMergeRequestNotFoundError.fromVcsError(
        {
          operation: "execute",
          command: "glab",
          cwd: input.cwd,
          reference: input.reference,
        },
        error,
      ),
    );

  return GitLabCli.of({
    execute,
    listMergeRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "mr",
          "list",
          "--source-branch",
          sourceRefName(input),
          ...stateArgs(input.state),
          "--per-page",
          String(input.limit ?? 20),
          "--output",
          "json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitLabMergeRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitLabMergeRequestListDecodeError({
                        operation: "listMergeRequests",
                        command: "glab",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success.map(toSummaryWithOptionalUpdatedAt));
                }),
              ),
        ),
      ),
    getMergeRequest: (input) =>
      executeMergeRequest({
        cwd: input.cwd,
        reference: input.reference,
        args: ["mr", "view", input.reference, "--output", "json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitLabMergeRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitLabMergeRequestDecodeError({
                    operation: "getMergeRequest",
                    command: "glab",
                    cwd: input.cwd,
                    reference: input.reference,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(toSummaryWithOptionalUpdatedAt(decoded.success));
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", `projects/${encodeURIComponent(input.repository)}`],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitLabRepositoryDecodeError({
                  operation: "getRepositoryCloneUrls",
                  command: "glab",
                  cwd: input.cwd,
                  repository: input.repository,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const { namespacePath, projectPath } = parseRepositoryPath(input.repository);
      const namespaceId: Effect.Effect<number | null, GitLabCliError> = namespacePath
        ? execute({
            cwd: input.cwd,
            args: ["api", `namespaces/${encodeURIComponent(namespacePath)}`],
          }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.flatMap((raw) =>
              decodeGitLabNamespace(raw).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitLabNamespaceDecodeError({
                      operation: "createRepository",
                      command: "glab",
                      cwd: input.cwd,
                      namespacePath,
                      cause,
                    }),
                ),
              ),
            ),
            Effect.map((namespace) => namespace.id),
          )
        : Effect.succeed(null);

      return namespaceId.pipe(
        Effect.flatMap((resolvedNamespaceId) =>
          execute({
            cwd: input.cwd,
            args: [
              "api",
              "--method",
              "POST",
              "projects",
              "--raw-field",
              `path=${projectPath}`,
              "--raw-field",
              `name=${projectPath}`,
              "--raw-field",
              `visibility=${input.visibility}`,
              ...(resolvedNamespaceId === null
                ? []
                : ["--raw-field", `namespace_id=${resolvedNamespaceId}`]),
            ],
          }),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitLabRepositoryDecodeError({
                  operation: "createRepository",
                  command: "glab",
                  cwd: input.cwd,
                  repository: input.repository,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createMergeRequest: (input) => {
      const sourceProject = sourceProjectIdentifier(input.source);
      return execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "POST",
          "projects/:fullpath/merge_requests",
          "--raw-field",
          `source_branch=${sourceRefName(input)}`,
          "--raw-field",
          `target_branch=${input.target?.refName ?? input.baseBranch}`,
          ...(sourceProject ? ["--raw-field", `source_project_id=${sourceProject}`] : []),
          "--raw-field",
          `title=${input.title}`,
          "--field",
          `description=@${input.bodyFile}`,
        ],
      }).pipe(Effect.asVoid);
    },
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "projects/:fullpath"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitLabDefaultBranch(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitLabRepositoryDecodeError({
                  operation: "getDefaultBranch",
                  command: "glab",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((value) => value.default_branch ?? null),
      ),
    checkoutMergeRequest: (input) =>
      executeMergeRequest({
        cwd: input.cwd,
        reference: input.reference,
        args: ["mr", "checkout", input.reference],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitLabCli, make);
