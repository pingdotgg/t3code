import { Context, Effect, Layer, Schema, SchemaIssue } from "effect";
import { TrimmedNonEmptyString, type SourceControlRepositoryVisibility } from "@forma/contracts";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";

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
  }) => Effect.Effect<ProcessRunResult, GitLabCliError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<GitLabRepositoryCloneUrls, GitLabCliError>;
}

export class GitLabCli extends Context.Service<GitLabCli, GitLabCliShape>()(
  "forma/source-control/GitLabCli",
) {}

function normalizeGitLabCliError(operation: "execute" | "stdout", error: unknown): GitLabCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: glab")) {
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

const RawGitLabNamespaceSchema = Schema.Struct({
  id: Schema.Number,
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitLabRepositoryCloneUrlsSchema>,
): GitLabRepositoryCloneUrls {
  return {
    nameWithOwner: raw.path_with_namespace,
    url: raw.http_url_to_repo,
    sshUrl: raw.ssh_url_to_repo,
  };
}

function decodeGitLabJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "createRepository",
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

function parseRepositoryPath(repository: string): {
  readonly namespacePath: string | null;
  readonly projectPath: string;
} {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const projectPath = parts.at(-1) ?? repository.trim();
  const namespacePath = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { namespacePath, projectPath };
}

export const make = Effect.fn("makeGitLabCli")(function* () {
  yield* Effect.void;

  const execute: GitLabCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("glab", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitLabCliError("execute", error),
    });

  return GitLabCli.of({
    execute,
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
    createRepository: (input) => {
      const { namespacePath, projectPath } = parseRepositoryPath(input.repository);
      const namespaceId: Effect.Effect<number | null, GitLabCliError> = namespacePath
        ? execute({
            cwd: input.cwd,
            args: ["api", `namespaces/${encodeURIComponent(namespacePath)}`],
          }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.flatMap((raw) =>
              decodeGitLabJson(
                raw,
                RawGitLabNamespaceSchema,
                "createRepository",
                "GitLab CLI returned invalid namespace JSON.",
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
          decodeGitLabJson(
            raw,
            RawGitLabRepositoryCloneUrlsSchema,
            "createRepository",
            "GitLab CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
  });
});

export const GitLabCliLive = Layer.effect(GitLabCli, make());
