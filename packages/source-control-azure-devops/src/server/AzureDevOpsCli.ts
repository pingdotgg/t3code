// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
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
const IDENTITY_OUTPUT_BYTES = 16_384;
const ORGANIZATION_PATTERN =
  /^https:\/\/(?:dev\.azure\.com\/[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9-]*\.visualstudio\.com)\/?$/i;
const encodeIdentityInput = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ organization: Schema.String })),
);
const decodeIdentityOutput = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      account: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
);
const CURRENT_IDENTITY_SCRIPT = String.raw`
import contextlib
import json
import logging
import os
import re
import sys

logging.disable(logging.CRITICAL)
output = sys.stdout
failure = "failed"
class IdentityError(Exception):
    def __init__(self, code):
        self.code = code
try:
    request = json.loads(sys.stdin.read(16385))
    organization = request["organization"]
    if set(request) != {"organization"} or not isinstance(organization, str) or len(organization) > 2048 or not re.fullmatch(r"https://(?:dev\.azure\.com/[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9-]*\.visualstudio\.com)/?", organization, re.I):
        raise IdentityError("failed")
    failure = "runtime"
    with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        from azure.cli.core import get_default_cli
        get_default_cli()
        from azure.cli.core.extension import get_extension, get_extension_path
        extension = get_extension("azure-devops")
        sys.path.append(extension.path or get_extension_path("azure-devops"))
        from azext_devops.dev.common import services
        from azext_devops.devops_sdk.exceptions import AzureDevOpsAuthenticationError
        def authentication_error(message):
            return IdentityError("authentication")
        services.get_authentication_error = authentication_error
        failure = "failed"
        connection = services.get_connection(organization)
        client = connection.get_client("azext_devops.devops_sdk.v5_0.location.location_client.LocationClient")
        original_handle_error = client._handle_error
        def handle_error(request, response):
            if response.status_code == 401:
                raise IdentityError("authentication")
            if response.status_code == 429:
                raise IdentityError("rate-limited")
            return original_handle_error(request, response)
        client._handle_error = handle_error
        try:
            identity = client.get_connection_data().authenticated_user
        except AzureDevOpsAuthenticationError:
            raise IdentityError("authentication") from None
        properties = identity.properties if identity else None
        account = properties.get("Account", {}).get("$value") if isinstance(properties, dict) else None
        if not isinstance(account, str) or not account.strip() or len(account) > 1024:
            raise IdentityError("failed")
        result = {"account": account.strip()}
except IdentityError as error:
    result = {"error": error.code}
except BaseException:
    result = {"error": failure}
json.dump(result, output, ensure_ascii=True)
output.write("\n")
`;

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
    return "Azure DevOps CLI is not authenticated. Run `az devops login` and retry.";
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
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;

    readonly getCurrentIdentity: (input: {
      readonly cwd: string;
      readonly organization: string;
    }) => Effect.Effect<string, AzureDevOpsCliError>;

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

export const executeJson = (
  execute: AzureDevOpsCli["Service"]["execute"],
  input: Parameters<AzureDevOpsCli["Service"]["execute"]>[0],
) => execute({ ...input, args: [...input.args, "--only-show-errors", "--output", "json"] });

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

  return AzureDevOpsCli.of({
    execute,
    getCurrentIdentity: (input) =>
      Effect.gen(function* () {
        const failure = (kind: string): AzureDevOpsCliError => {
          const fields = {
            operation: "execute" as const,
            command: "az" as const,
            cwd: input.cwd,
            argumentCount: 3,
            cause: ["runtime", "authentication", "rate-limited"].includes(kind) ? kind : "failed",
          };
          switch (kind) {
            case "runtime":
              return new AzureDevOpsCliUnavailableError(fields);
            case "authentication":
              return new AzureDevOpsCliAuthenticationError(fields);
            case "rate-limited":
              return new AzureDevOpsCliRateLimitError(fields);
            default:
              return new AzureDevOpsCommandFailedError(fields);
          }
        };
        if (
          input.organization.length > 2048 ||
          input.organization.trim() !== input.organization ||
          !ORGANIZATION_PATTERN.test(input.organization)
        )
          return yield* failure("failed");
        const run = (request: SourceControlHost.SourceControlProcessInput) =>
          process.run(request).pipe(
            Effect.mapError((error) =>
              failure(
                AzureDevOpsCommandFailedError.fromVcsError(
                  {
                    operation: "execute",
                    command: "az",
                    cwd: input.cwd,
                    argumentCount: request.args.length,
                  },
                  error,
                )._tag === "AzureDevOpsCliUnavailableError"
                  ? "runtime"
                  : "failed",
              ),
            ),
            Effect.flatMap((result) =>
              result.exitCode !== 0 ||
              result.stdoutTruncated ||
              result.stderrTruncated ||
              result.stdoutInvalidUtf8 ||
              result.stderrInvalidUtf8
                ? Effect.fail(failure("failed"))
                : Effect.succeed(result.stdout),
            ),
          );
        const options = {
          operation: "AzureDevOpsCli.getCurrentIdentity",
          cwd: input.cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxOutputBytes: IDENTITY_OUTPUT_BYTES,
          env: { AZURE_AUTO_UPGRADE_ENABLE: "false", AZURE_CORE_COLLECT_TELEMETRY: "false" },
        };
        const version = yield* run({ ...options, command: "az", args: ["--version"] });
        const locations = [...version.matchAll(/^Python location '([^\r\n\0]+)'\r?$/gm)];
        const python = locations.length === 1 ? locations[0]?.[1] : undefined;
        if (!python || !NodePath.isAbsolute(python)) return yield* failure("runtime");
        const stdin = yield* encodeIdentityInput({ organization: input.organization }).pipe(
          Effect.mapError(() => failure("failed")),
        );
        const raw = yield* run({
          ...options,
          command: python,
          args: ["-B", "-c", CURRENT_IDENTITY_SCRIPT],
          spawnCwd: NodePath.dirname(python),
          stdin,
        });
        const decoded = yield* decodeIdentityOutput(raw).pipe(
          Effect.mapError(() => failure("failed")),
        );
        if (decoded.error) return yield* failure(decoded.error);
        const account = decoded.account?.trim();
        if (!account || account.length > 1024) return yield* failure("failed");
        return account;
      }),
    listPullRequests: (input) =>
      executeJson(execute, {
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
      executeJson(execute, {
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
      executeJson(execute, {
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
      return executeJson(execute, {
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
      executeJson(execute, {
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
