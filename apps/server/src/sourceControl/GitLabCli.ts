import { Context, Effect, Layer, Option, Result, Schema, SchemaIssue, type DateTime } from "effect";

import { TrimmedNonEmptyString } from "@t3tools/contracts";

import {
  decodeGitLabMergeRequestJson,
  decodeGitLabMergeRequestListJson,
  formatGitLabJsonDecodeError,
} from "./gitLabMergeRequests.ts";
import { VcsProcess, type VcsProcessOutput } from "../vcs/VcsProcess.ts";
import type { SourceControlRefSelector } from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitLabCliError extends Schema.TaggedErrorClass<GitLabCliError>()("GitLabCliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

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

export interface GitLabCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcessOutput, GitLabCliError>;

  readonly listMergeRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
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

  readonly createMergeRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
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

export class GitLabCli extends Context.Service<GitLabCli, GitLabCliShape>()(
  "t3/source-control/GitLabCli",
) {}

function isVcsProcessSpawnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VcsProcessSpawnError"
  );
}

function normalizeGitLabCliError(operation: "execute" | "stdout", error: unknown): GitLabCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: glab") || isVcsProcessSpawnError(error)) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI (`glab`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("glab auth login") ||
      lower.includes("token")
    ) {
      return new GitLabCliError({
        operation,
        detail: "GitLab CLI is not authenticated. Run `glab auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("merge request not found") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      return new GitLabCliError({
        operation,
        detail: "Merge request not found. Check the MR number or URL and try again.",
        cause: error,
      });
    }

    return new GitLabCliError({
      operation,
      detail: `GitLab CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitLabCliError({
    operation,
    detail: "GitLab CLI command failed.",
    cause: error,
  });
}

const RawGitLabRepositoryCloneUrlsSchema = Schema.Struct({
  path_with_namespace: TrimmedNonEmptyString,
  web_url: TrimmedNonEmptyString,
  http_url_to_repo: TrimmedNonEmptyString,
  ssh_url_to_repo: TrimmedNonEmptyString,
});

const RawGitLabDefaultBranchSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitLabRepositoryCloneUrlsSchema>,
): GitLabRepositoryCloneUrls {
  return {
    nameWithOwner: raw.path_with_namespace,
    url: raw.http_url_to_repo || raw.web_url,
    sshUrl: raw.ssh_url_to_repo,
  };
}

function decodeGitLabJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitLabCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitLabCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
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
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

function sourceProjectIdentifier(source: SourceControlRefSelector | undefined): string | null {
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

export const make = Effect.fn("makeGitLabCli")(function* () {
  const process = yield* VcsProcess;

  const execute: GitLabCliShape["execute"] = (input) =>
    process
      .run({
        operation: "GitLabCli.execute",
        command: "glab",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => normalizeGitLabCliError("execute", error)));

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
                      new GitLabCliError({
                        operation: "listMergeRequests",
                        detail: `GitLab CLI returned invalid MR list JSON: ${formatGitLabJsonDecodeError(decoded.failure)}`,
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
      execute({
        cwd: input.cwd,
        args: ["mr", "view", input.reference, "--output", "json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitLabMergeRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitLabCliError({
                    operation: "getMergeRequest",
                    detail: `GitLab CLI returned invalid merge request JSON: ${formatGitLabJsonDecodeError(decoded.failure)}`,
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
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
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
          decodeGitLabJson(
            raw,
            RawGitLabDefaultBranchSchema,
            "getDefaultBranch",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((value) => value.default_branch ?? null),
      ),
    checkoutMergeRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["mr", "checkout", input.reference],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitLabCli, make());
