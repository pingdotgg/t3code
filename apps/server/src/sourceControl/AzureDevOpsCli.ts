import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";
import {
  parseAzureDevOpsRepositoryCoordinates,
  type AzureDevOpsRepositoryCoordinates,
} from "@t3tools/shared/sourceControl";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Identifies the Azure DevOps repository targeted by a CLI request. */
export type AzureDevOpsRepositoryContext = AzureDevOpsRepositoryCoordinates;

/** Extracts repository coordinates from an Azure DevOps SSH or HTTPS clone URL. */
export function parseAzureDevOpsRemoteUrl(
  remoteUrl: string,
): AzureDevOpsRepositoryContext | undefined {
  return parseAzureDevOpsRepositoryCoordinates(remoteUrl);
}

/** Builds explicit Azure CLI repository arguments when remote detection is unreliable. */
function repositoryDetectionArgs(
  repositoryContext: AzureDevOpsRepositoryContext | undefined,
): ReadonlyArray<string> {
  return repositoryContext
    ? [
        "--organization",
        `https://dev.azure.com/${repositoryContext.organization}`,
        "--project",
        repositoryContext.project,
        "--repository",
        repositoryContext.repository,
      ]
    : ["--detect", "true"];
}

/** Builds the organization argument used by PR commands that do not accept a repository. */
function repositoryOrganizationArgs(
  repositoryContext: AzureDevOpsRepositoryContext | undefined,
): ReadonlyArray<string> {
  return repositoryContext
    ? ["--organization", `https://dev.azure.com/${repositoryContext.organization}`]
    : ["--detect", "true"];
}

/** Resolves a repository selector against the current Azure organization and project. */
function repositorySelectorCoordinates(
  repositoryContext: AzureDevOpsRepositoryContext,
  repository: string,
): AzureDevOpsRepositoryContext {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const repositoryName = parts.at(-1) ?? repositoryContext.repository;
  const project =
    parts.length > 1 ? (parts.at(-2) ?? repositoryContext.project) : repositoryContext.project;
  const organization =
    parts.length > 2
      ? (parts.at(-3) ?? repositoryContext.organization)
      : repositoryContext.organization;

  return {
    organization,
    project,
    repository: repositoryName,
  };
}

/** Parses an organization/project/repository selector without relying on Git remote detection. */
function qualifiedRepositorySelectorCoordinates(
  repository: string,
): AzureDevOpsRepositoryContext | undefined {
  const parts = repository
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const organization = parts.at(-3);
  const project = parts.at(-2);
  const repositoryName = parts.at(-1);
  return organization && project && repositoryName
    ? { organization, project, repository: repositoryName }
    : undefined;
}

/** Builds repository-show arguments while retaining the CLI's fallback repository selector. */
function repositoryShowArgs(
  repositoryContext: AzureDevOpsRepositoryContext | undefined,
  repository: string,
): ReadonlyArray<string> {
  const selectedRepository =
    repositoryContext === undefined
      ? qualifiedRepositorySelectorCoordinates(repository)
      : repositorySelectorCoordinates(repositoryContext, repository);
  if (selectedRepository === undefined) {
    return ["--detect", "true", "--repository", repository];
  }

  return [
    "--organization",
    `https://dev.azure.com/${selectedRepository.organization}`,
    "--project",
    selectedRepository.project,
    "--repository",
    selectedRepository.repository,
  ];
}

const azureDevOpsCommandErrorFields = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("az"),
  cwd: Schema.String,
  argumentCount: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsCliUnavailableError extends Schema.TaggedErrorClass<AzureDevOpsCliUnavailableError>()(
  "AzureDevOpsCliUnavailableError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure CLI (`az`) with the Azure DevOps extension is required but not available on PATH.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliAuthenticationError extends Schema.TaggedErrorClass<AzureDevOpsCliAuthenticationError>()(
  "AzureDevOpsCliAuthenticationError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestNotFoundError extends Schema.TaggedErrorClass<AzureDevOpsPullRequestNotFoundError>()(
  "AzureDevOpsPullRequestNotFoundError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCommandFailedError extends Schema.TaggedErrorClass<AzureDevOpsCommandFailedError>()(
  "AzureDevOpsCommandFailedError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps CLI command failed.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "az";
      readonly cwd: string;
      readonly argumentCount: number;
    },
    cause: VcsError,
  ): AzureDevOpsCliError {
    const fields = { ...context, cause };

    if (
      cause._tag === "VcsProcessSpawnError" &&
      cause.cause instanceof PlatformError.PlatformError &&
      cause.cause.reason._tag === "NotFound" &&
      cause.cause.reason.pathOrDescriptor !== context.cwd &&
      cause.cause.reason.syscall !== "chdir"
    ) {
      return new AzureDevOpsCliUnavailableError(fields);
    }

    if (cause._tag === "VcsProcessExitError") {
      if (cause.failureKind === "authentication") {
        return new AzureDevOpsCliAuthenticationError(fields);
      }
      if (cause.failureKind === "not-found") {
        return new AzureDevOpsPullRequestNotFoundError(fields);
      }
    }

    return new AzureDevOpsCommandFailedError(fields);
  }
}

export class AzureDevOpsGitCommandFailedError extends Schema.TaggedErrorClass<AzureDevOpsGitCommandFailedError>()(
  "AzureDevOpsGitCommandFailedError",
  {
    operation: Schema.Literal("checkoutPullRequest"),
    stage: Schema.Literals(["fetch", "checkout"]),
    command: Schema.Literal("git"),
    cwd: Schema.String,
    argumentCount: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Git ${this.stage} command failed.`;
  }

  override get message(): string {
    return `Azure DevOps Git ${this.stage} command failed in ${this.operation}: ${this.detail}`;
  }
}

const azureDevOpsDecodeErrorFields = {
  command: Schema.Literal("az"),
  cwd: Schema.String,
  outputLength: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsPullRequestListDecodeError extends Schema.TaggedErrorClass<AzureDevOpsPullRequestListDecodeError>()(
  "AzureDevOpsPullRequestListDecodeError",
  {
    operation: Schema.Literal("listPullRequests"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestDecodeError extends Schema.TaggedErrorClass<AzureDevOpsPullRequestDecodeError>()(
  "AzureDevOpsPullRequestDecodeError",
  {
    operation: Schema.Literal("getPullRequest"),
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

const AzureDevOpsRepositoryDecodeOperation = Schema.Literals([
  "getRepositoryCloneUrls",
  "getDefaultBranch",
  "createRepository",
]);

export class AzureDevOpsRepositoryDecodeError extends Schema.TaggedErrorClass<AzureDevOpsRepositoryDecodeError>()(
  "AzureDevOpsRepositoryDecodeError",
  {
    operation: AzureDevOpsRepositoryDecodeOperation,
    ...azureDevOpsDecodeErrorFields,
  },
) {
  get detail(): string {
    return "Azure DevOps CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const AzureDevOpsCliError = Schema.Union([
  AzureDevOpsCliUnavailableError,
  AzureDevOpsCliAuthenticationError,
  AzureDevOpsPullRequestNotFoundError,
  AzureDevOpsCommandFailedError,
  AzureDevOpsGitCommandFailedError,
  AzureDevOpsPullRequestListDecodeError,
  AzureDevOpsPullRequestDecodeError,
  AzureDevOpsRepositoryDecodeError,
]);
export type AzureDevOpsCliError = typeof AzureDevOpsCliError.Type;

export const isAzureDevOpsCliError = Schema.is(AzureDevOpsCliError);

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class AzureDevOpsCli extends Context.Service<
  AzureDevOpsCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, AzureDevOpsCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>, AzureDevOpsCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
    }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<AzureDevOpsRepositoryCloneUrls, AzureDevOpsCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
    }) => Effect.Effect<string | null, AzureDevOpsCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly repositoryContext?: AzureDevOpsRepositoryContext;
      readonly remoteName?: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;
  }
>()("t3/sourceControl/AzureDevOpsCli") {}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  return urlMatch?.[1] ?? trimmed;
}

function toAzureStatus(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "active";
    case "closed":
      return "abandoned";
    case "merged":
      return "completed";
    case "all":
      return "all";
  }
}

const RawAzureDevOpsRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  webUrl: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  project: Schema.optional(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  defaultBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

function normalizeDefaultBranch(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^refs\/heads\//, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawAzureDevOpsRepositorySchema>,
): AzureDevOpsRepositoryCloneUrls {
  const projectName = raw.project?.name.trim();
  return {
    nameWithOwner: projectName ? `${projectName}/${raw.name}` : raw.name,
    url: raw.remoteUrl,
    sshUrl: raw.sshUrl,
  };
}

function parseRepositorySpecifier(repository: string): {
  readonly project: string | null;
  readonly name: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return {
    project: parts.length > 1 ? (parts.at(-2) ?? null) : null,
    name: parts.at(-1) ?? repository.trim(),
  };
}

/** Returns whether a Git remote uses an SSH transport. */
function isSshRemoteUrl(remoteUrl: string | undefined): boolean {
  const trimmed = remoteUrl?.trim() ?? "";
  return /^git@/iu.test(trimmed) || /^ssh:\/\//iu.test(trimmed);
}

/** Chooses a fork clone URL that matches the local repository's Git transport. */
function forkRepositoryRemote(input: {
  readonly pullRequest: NormalizedAzureDevOpsPullRequestRecord;
  readonly remoteName: string;
  readonly remoteUrl?: string;
}): string {
  const sshUrl = input.pullRequest.sourceRepositorySshUrl;
  const httpsUrl = input.pullRequest.sourceRepositoryRemoteUrl;
  if (isSshRemoteUrl(input.remoteUrl)) {
    return sshUrl ?? httpsUrl ?? input.remoteName;
  }
  if (input.remoteUrl !== undefined) {
    return httpsUrl ?? sshUrl ?? input.remoteName;
  }
  return sshUrl ?? httpsUrl ?? input.remoteName;
}

function decodeAzureDevOpsJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: typeof AzureDevOpsRepositoryDecodeOperation.Type,
  cwd: string,
): Effect.Effect<S["Type"], AzureDevOpsRepositoryDecodeError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (cause) =>
        new AzureDevOpsRepositoryDecodeError({
          operation,
          command: "az",
          cwd,
          outputLength: raw.length,
          cause,
        }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: AzureDevOpsCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(
        Effect.mapError((error) =>
          AzureDevOpsCommandFailedError.fromVcsError(
            {
              operation: "execute",
              command: "az",
              cwd: input.cwd,
              argumentCount: input.args.length,
            },
            error,
          ),
        ),
      );

  const executeJson = (input: Parameters<AzureDevOpsCli["Service"]["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  /** Runs one git step of the SSH-safe pull-request checkout flow. */
  const runGit = (input: {
    readonly cwd: string;
    readonly stage: "fetch" | "checkout";
    readonly args: ReadonlyArray<string>;
  }) =>
    process
      .run({
        operation: "AzureDevOpsCli.checkoutPullRequest",
        command: "git",
        args: input.args,
        cwd: input.cwd,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AzureDevOpsGitCommandFailedError({
              operation: "checkoutPullRequest",
              stage: input.stage,
              command: "git",
              cwd: input.cwd,
              argumentCount: input.args.length,
              cause,
            }),
        ),
      );

  /** Loads a pull request using explicit organization context when available. */
  const getPullRequest: AzureDevOpsCli["Service"]["getPullRequest"] = (input) =>
    executeJson({
      cwd: input.cwd,
      args: [
        "repos",
        "pr",
        "show",
        ...repositoryOrganizationArgs(input.repositoryContext),
        "--id",
        normalizeChangeRequestId(input.reference),
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        Effect.sync(() => decodeAzureDevOpsPullRequestJson(raw)).pipe(
          Effect.flatMap((decoded) => {
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new AzureDevOpsPullRequestDecodeError({
                  operation: "getPullRequest",
                  command: "az",
                  cwd: input.cwd,
                  outputLength: raw.length,
                  cause: decoded.failure,
                }),
              );
            }

            return Effect.succeed(decoded.success);
          }),
        ),
      ),
    );

  return AzureDevOpsCli.of({
    execute,
    listPullRequests: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          ...repositoryDetectionArgs(input.repositoryContext),
          "--source-branch",
          SourceControlProvider.sourceBranch(input),
          "--status",
          toAzureStatus(input.state),
          "--top",
          String(input.limit ?? 20),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeAzureDevOpsPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new AzureDevOpsPullRequestListDecodeError({
                        operation: "listPullRequests",
                        command: "az",
                        cwd: input.cwd,
                        outputLength: raw.length,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest,
    getRepositoryCloneUrls: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", ...repositoryShowArgs(input.repositoryContext, input.repository)],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(
            raw,
            RawAzureDevOpsRepositorySchema,
            "getRepositoryCloneUrls",
            input.cwd,
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) => {
      const repository = parseRepositorySpecifier(input.repository);
      // Azure Repos access is governed by project/organization permissions.
      // `az repos create` does not expose a per-repository visibility flag, so
      // the generic source-control visibility input is intentionally not
      // translated into CLI args for this provider.
      return executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          repository.name,
          ...(repository.project ? ["--project", repository.project] : []),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "createRepository", input.cwd),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      );
    },
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "create",
          "--only-show-errors",
          ...repositoryDetectionArgs(input.repositoryContext),
          "--target-branch",
          input.target?.refName ?? input.baseBranch,
          "--source-branch",
          SourceControlProvider.sourceBranch(input),
          "--title",
          input.title,
          "--description",
          `@${input.bodyFile}`,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", ...repositoryDetectionArgs(input.repositoryContext)],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      ),
    checkoutPullRequest: (input) => {
      const reference = normalizeChangeRequestId(input.reference);
      const remoteName = input.remoteName ?? "origin";

      if (input.repositoryContext === undefined) {
        return execute({
          cwd: input.cwd,
          args: [
            "repos",
            "pr",
            "checkout",
            "--only-show-errors",
            "--id",
            reference,
            "--remote-name",
            remoteName,
          ],
        }).pipe(Effect.asVoid);
      }

      return getPullRequest({
        cwd: input.cwd,
        reference,
        repositoryContext: input.repositoryContext,
      }).pipe(
        Effect.flatMap((pullRequest) => {
          const branch = pullRequest.headRefName;
          return Effect.gen(function* () {
            yield* runGit({
              cwd: input.cwd,
              stage: "fetch",
              args: [
                "fetch",
                forkRepositoryRemote({
                  pullRequest,
                  remoteName,
                  ...(input.remoteUrl !== undefined ? { remoteUrl: input.remoteUrl } : {}),
                }),
                `+refs/heads/${branch}`,
              ],
            });
            yield* runGit({
              cwd: input.cwd,
              stage: "checkout",
              args: ["checkout", "-B", branch, "FETCH_HEAD"],
            });
          });
        }),
      );
    },
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
