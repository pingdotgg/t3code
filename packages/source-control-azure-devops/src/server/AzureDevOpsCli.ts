import {
  PULL_REQUEST_CONTEXT_SCRIPT,
  PATCH_PULL_REQUEST_SCRIPT,
  withAzureSdkErrors,
  UPLOAD_ATTACHMENT_SCRIPT,
  AUTHENTICATED_IDENTITY_SCRIPT,
  RESOLVE_IDENTITIES_SCRIPT,
  NOTIFICATION_SUBSCRIPTIONS_SCRIPT,
} from "./azureDevOpsSdk.ts";
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

import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

const DEFAULT_TIMEOUT_MS = 30_000;
const decodeAuthenticatedIdentity = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ id: TrimmedNonEmptyString, login: TrimmedNonEmptyString, name: Schema.String }),
  ),
);

const azureDevOpsCommandErrorFields = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("az"),
  cwd: Schema.String,
  argumentCount: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsCliUnavailableError extends Schema.TaggedError<AzureDevOpsCliUnavailableError>()(
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

export class AzureDevOpsCliAuthenticationError extends Schema.TaggedError<AzureDevOpsCliAuthenticationError>()(
  "AzureDevOpsCliAuthenticationError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps authentication failed or this credential lacks the required scope. Check its access and run `az devops login` if it needs to be renewed.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsCliRateLimitError extends Schema.TaggedError<AzureDevOpsCliRateLimitError>()(
  "AzureDevOpsCliRateLimitError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "Azure DevOps API rate limit exceeded.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsPullRequestNotFoundError extends Schema.TaggedError<AzureDevOpsPullRequestNotFoundError>()(
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

export class AzureDevOpsCommandFailedError extends Schema.TaggedError<AzureDevOpsCommandFailedError>()(
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
      if (cause.failureKind === "rate-limited") {
        return new AzureDevOpsCliRateLimitError(fields);
      }
      if (cause.failureKind === "not-found") {
        return new AzureDevOpsPullRequestNotFoundError(fields);
      }
    }

    return new AzureDevOpsCommandFailedError(fields);
  }
}

export class AzureDevOpsNativeRequestError extends Schema.TaggedError<AzureDevOpsNativeRequestError>()(
  "AzureDevOpsNativeRequestError",
  {
    ...azureDevOpsCommandErrorFields,
    reason: Schema.Literals(["permission-denied", "failed"]),
  },
) {
  get detail(): string {
    return this.reason === "permission-denied"
      ? "Your Azure credential lacks the required scope or permission for this action."
      : "Azure refused this operation.";
  }
  override get message(): string {
    return this.detail;
  }
}

const azureDevOpsDecodeErrorFields = {
  command: Schema.Literal("az"),
  cwd: Schema.String,
  outputLength: NonNegativeInt,
  cause: Schema.Defect(),
};

export class AzureDevOpsPullRequestListDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestListDecodeError>()(
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

export class AzureDevOpsPullRequestDecodeError extends Schema.TaggedError<AzureDevOpsPullRequestDecodeError>()(
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

export class AzureDevOpsRepositoryDecodeError extends Schema.TaggedError<AzureDevOpsRepositoryDecodeError>()(
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
  AzureDevOpsCliRateLimitError,
  AzureDevOpsPullRequestNotFoundError,
  AzureDevOpsCommandFailedError,
  AzureDevOpsNativeRequestError,
  AzureDevOpsPullRequestListDecodeError,
  AzureDevOpsPullRequestDecodeError,
  AzureDevOpsRepositoryDecodeError,
]);
export type AzureDevOpsCliError = typeof AzureDevOpsCliError.Type;

export interface AzureDevOpsRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class AzureDevOpsCli extends Context.Service<
  AzureDevOpsCli,
  {
    readonly pullRequestContext: (input: {
      cwd: string;
      project: string;
      repository: string;
      number: number;
      operation: "permissions" | "visit";
      hashes?: ReadonlyArray<string>;
      viewed?: boolean;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;
    readonly uploadAttachment: (input: {
      cwd: string;
      routeValues: { project: string; repositoryId: string; pullRequestId: string };
      fileName: string;
      data: string;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;
    readonly notificationSubscriptions: (input: {
      cwd: string;
      method: "GET" | "POST" | "DELETE";
      viewerId?: string;
      subscriptionId?: string;
      bodyFile?: string;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;
    readonly resolveIdentities: (input: {
      cwd: string;
      descriptors: ReadonlyArray<string>;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;
    readonly authenticatedIdentity: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      { readonly id: string; readonly login: string; readonly name: string },
      AzureDevOpsCliError
    >;
    readonly patchPullRequest: (input: {
      readonly cwd: string;
      readonly bodyFile: string;
      readonly routeValues: {
        readonly project: string;
        readonly repositoryId: string;
        readonly pullRequestId: string;
      };
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>, AzureDevOpsCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
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
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, AzureDevOpsCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly remoteName?: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCli") {}

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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  const execute: AzureDevOpsCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
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

  const decodeSdkFailure = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({ _t3SdkError: Schema.Struct({ message: Schema.String }) }),
    ),
  );
  let pythonPath: string | undefined;
  const encodePatchRequest = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        bodyFile: Schema.String,
        routeValues: Schema.Struct({
          project: Schema.String,
          repositoryId: Schema.String,
          pullRequestId: Schema.String,
        }),
      }),
    ),
  );
  const runSdk = Effect.fn("AzureDevOpsCli.runSdk")(function* (input: {
    cwd: string;
    script: string;
    stdin?: string;
  }) {
    if (pythonPath === undefined) {
      const version = yield* execute({ cwd: input.cwd, args: ["--version"] });
      pythonPath = /Python location ['"]([^'"\r\n]+)['"]/.exec(
        `${version.stdout}\n${version.stderr}`,
      )?.[1];
      if (pythonPath === undefined)
        return yield* new AzureDevOpsCommandFailedError({
          operation: "execute",
          command: "az",
          cwd: input.cwd,
          argumentCount: 1,
          cause: "Azure CLI did not report its Python runtime.",
        });
    }
    return yield* process
      .run({
        operation: "AzureDevOpsCli.runSdk",
        command: pythonPath,
        args: ["-I", "-c", withAzureSdkErrors(input.script)],
        cwd: input.cwd,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((output) => {
          const failure = decodeSdkFailure(output.stdout);
          return failure._tag === "Some"
            ? Effect.fail(
                new AzureDevOpsNativeRequestError({
                  operation: "execute",
                  command: "az",
                  cwd: input.cwd,
                  argumentCount: 3,
                  reason:
                    /access denied|not authorized|requires user authentication|TF401027|required Azure DevOps scope|lacks.*permission/i.test(
                      failure.value._t3SdkError.message,
                    )
                      ? "permission-denied"
                      : "failed",
                  cause: failure.value._t3SdkError.message,
                }),
              )
            : Effect.succeed(output);
        }),
        Effect.mapError((error) =>
          error._tag === "AzureDevOpsNativeRequestError"
            ? error
            : AzureDevOpsCommandFailedError.fromVcsError(
                { operation: "execute", command: "az", cwd: input.cwd, argumentCount: 3 },
                error,
              ),
        ),
      );
  });

  const patchPullRequest: AzureDevOpsCli["Service"]["patchPullRequest"] = Effect.fn(
    "AzureDevOpsCli.patchPullRequest",
  )(function* (input) {
    const stdin = yield* encodePatchRequest({
      bodyFile: input.bodyFile,
      routeValues: input.routeValues,
    }).pipe(Effect.orDie);
    return yield* runSdk({ cwd: input.cwd, script: PATCH_PULL_REQUEST_SCRIPT, stdin });
  });
  const encodeSdkRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const notificationSubscriptions: AzureDevOpsCli["Service"]["notificationSubscriptions"] =
    Effect.fn("AzureDevOpsCli.notificationSubscriptions")(function* (input) {
      const stdin = yield* encodeSdkRequest(input).pipe(Effect.orDie);
      return yield* runSdk({ cwd: input.cwd, script: NOTIFICATION_SUBSCRIPTIONS_SCRIPT, stdin });
    });
  const uploadAttachment: AzureDevOpsCli["Service"]["uploadAttachment"] = Effect.fn(
    "AzureDevOpsCli.uploadAttachment",
  )(function* (input) {
    const stdin = yield* encodeSdkRequest(input).pipe(Effect.orDie);
    return yield* runSdk({ cwd: input.cwd, script: UPLOAD_ATTACHMENT_SCRIPT, stdin });
  });
  const resolveIdentities: AzureDevOpsCli["Service"]["resolveIdentities"] = Effect.fn(
    "AzureDevOpsCli.resolveIdentities",
  )(function* (input) {
    const stdin = yield* encodeSdkRequest({ descriptors: input.descriptors }).pipe(Effect.orDie);
    return yield* runSdk({ cwd: input.cwd, script: RESOLVE_IDENTITIES_SCRIPT, stdin });
  });
  const authenticatedIdentity: AzureDevOpsCli["Service"]["authenticatedIdentity"] = (input) =>
    runSdk({ cwd: input.cwd, script: AUTHENTICATED_IDENTITY_SCRIPT }).pipe(
      Effect.flatMap((output) => decodeAuthenticatedIdentity(output.stdout)),
      Effect.mapError((cause) =>
        cause._tag === "AzureDevOpsNativeRequestError"
          ? cause
          : new AzureDevOpsCommandFailedError({
              operation: "execute",
              command: "az",
              cwd: input.cwd,
              argumentCount: 3,
              cause,
            }),
      ),
    );

  const executeJson = (input: Parameters<AzureDevOpsCli["Service"]["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  return AzureDevOpsCli.of({
    patchPullRequest,
    authenticatedIdentity,
    resolveIdentities,
    pullRequestContext: (input) =>
      encodeSdkRequest(input).pipe(
        Effect.orDie,
        Effect.flatMap((stdin) =>
          runSdk({ cwd: input.cwd, script: PULL_REQUEST_CONTEXT_SCRIPT, stdin }),
        ),
      ),
    notificationSubscriptions,
    uploadAttachment,
    execute,
    listPullRequests: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
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
    getPullRequest: (input) =>
      executeJson({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
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
      ),
    getRepositoryCloneUrls: (input) =>
      executeJson({
        cwd: input.cwd,
        args: ["repos", "show", "--detect", "true", "--repository", input.repository],
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
          "--detect",
          "true",
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
        args: ["repos", "show", "--detect", "true"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          normalizeChangeRequestId(input.reference),
          "--remote-name",
          input.remoteName ?? "origin",
        ],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
