import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
  type VcsProcessExitFailureKind,
} from "@t3tools/contracts";

import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type { AzureDevOpsAvatarIdentity } from "../shared/azureDevOpsAvatar.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AzureCliInstallLocation } from "./azureCliLauncher.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

const DEFAULT_TIMEOUT_MS = 30_000;

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

export interface AzureDevOpsIdentityAvatar {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif";
}

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
      /** The remote T3 selected; without one, the checkout's primary remote scopes the command. */
      readonly remoteUrl?: string;
      readonly stdin?: string;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, AzureDevOpsCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
      readonly remoteUrl?: string;
    }) => Effect.Effect<ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>, AzureDevOpsCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<NormalizedAzureDevOpsPullRequestRecord, AzureDevOpsCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly remoteUrl?: string;
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
      readonly remoteUrl?: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<string | null, AzureDevOpsCliError>;

    /**
     * Cached per identity. `null` means Azure answered but had no image `az` could decode; the
     * error channel keeps an unauthenticated or missing `az` distinguishable for logging.
     */
    readonly getIdentityAvatar: (input: {
      readonly cwd: string;
      readonly identity: AzureDevOpsAvatarIdentity;
    }) => Effect.Effect<AzureDevOpsIdentityAvatar | null, AzureDevOpsCliError>;
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

/** The remote that scopes `az` when T3 selected none, from `git remote -v` output. */
export function primaryRemoteUrl(output: string) {
  if (!output.endsWith("\n")) return null;
  const remotes = new Map<string, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(trimmed);
    if (!match?.[1] || !match[2]) return null;
    if (match[3] === "fetch" && !remotes.has(match[1])) remotes.set(match[1], match[2]);
  }
  // Match the provider context SourceControlProviderRegistry binds, and `az`'s own detection.
  return (
    remotes.get("origin") ??
    [...remotes.values()].find((url) => scopeFromRemoteUrl(url) !== null) ??
    null
  );
}

function scopeFromRemoteUrl(remote: string) {
  try {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(remote);
    const url = new URL(
      remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote,
    );
    if (url.search || url.hash) return null;
    const legacy = url.hostname.endsWith(".visualstudio.com");
    const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
    let organization: string | undefined;
    if (
      url.protocol === "ssh:" &&
      (url.hostname === "ssh.dev.azure.com" || url.hostname === "vs-ssh.visualstudio.com")
    ) {
      if (parts.length !== 4 || parts.shift() !== "v3") return null;
      organization = parts.shift();
    } else if (url.protocol === "https:") {
      if (url.hostname === "dev.azure.com") organization = parts.shift();
      else {
        organization = /^([^.]+)\.visualstudio\.com$/u.exec(url.hostname)?.[1];
        if (!organization) return null;
        if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
      }
      if (parts.length !== 3 || parts[1] !== "_git") return null;
      parts.splice(1, 1);
    } else return null;
    const [project, repository] = parts;
    if (!organization || !project || !repository) return null;
    // `az` replaces a value starting with `@` by the contents of that local file.
    if ([organization, project, repository].some((part) => /^@|[\p{Cc}/\\]/u.test(part))) {
      return null;
    }
    if (legacy && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(organization))
      return null;
    return {
      // az keys organization-scoped credentials by the original host family.
      organization: legacy
        ? `https://${organization}.visualstudio.com`
        : `https://dev.azure.com/${encodeURIComponent(organization)}`,
      project,
      repository,
    };
  } catch {
    return null;
  }
}

const remoteOf = (input: { readonly remoteUrl?: string }) =>
  input.remoteUrl === undefined ? {} : { remoteUrl: input.remoteUrl };

const hasOption = (args: ReadonlyArray<string>, pattern: RegExp) =>
  args.some((arg) => pattern.test(arg));

/** Whether `az` would run `--detect true`, which inspects the checkout from wherever `az` runs. */
const detectsScope = (args: ReadonlyArray<string>) => {
  const detect = args.indexOf("--detect");
  return (
    args[0] !== "account" &&
    detect !== -1 &&
    args[detect + 1] === "true" &&
    !hasOption(args, /^(?:--organization|--org)(?:=|$)/u)
  );
};

/** Replaces `--detect true` with the scope of an Azure remote. */
export function scopeAzureCliArgs(
  args: ReadonlyArray<string>,
  remoteUrl: string,
): ReadonlyArray<string> {
  const scope = detectsScope(args) ? scopeFromRemoteUrl(remoteUrl) : null;
  if (!scope) return args;
  const scoped = [...args, "--organization", scope.organization];
  scoped[args.indexOf("--detect") + 1] = "false";
  // PR-ID commands and devops invoke accept only organization scope.
  const acceptsProject =
    args[0] === "repos" &&
    (args[1] === "show" ||
      args[1] === "create" ||
      (args[1] === "pr" && (args[2] === "list" || args[2] === "create")));
  if (!acceptsProject) return scoped;
  // Joined so a name starting with `-` stays the option's value.
  if (!hasOption(args, /^(?:--project|-p)(?:=|$)/u)) scoped.push(`--project=${scope.project}`);
  if (args[1] !== "create" && !hasOption(args, /^(?:--repository|-r)(?:=|$)/u)) {
    scoped.push(`--repository=${scope.repository}`);
  }
  return scoped;
}

const classifyAzFailure = (stderr: string): VcsProcessExitFailureKind | null => {
  const normalized = stderr.toLowerCase();
  if (normalized.includes("az devops login") || /please run '?az login'?/.test(normalized)) {
    return "authentication";
  }
  // Azure DevOps reports usage-limit throttling as TF400733, often without an HTTP status.
  if (normalized.includes("tf400733")) return "rate-limited";
  return normalized.includes("pull request") &&
    (normalized.includes("not found") || normalized.includes("does not exist"))
    ? "not-found"
    : null;
};

const AVATAR_CACHE_CAPACITY = 500;
// Each lookup runs two `az` Python processes in turn; a list with many authors must not start
// them all at once on the host that also runs the user's agents.
/** @public */
export const MAX_AVATAR_LOOKUPS = 2;
// People rarely change their picture, and a lookup costs two `az` processes.
const AVATAR_TTL = "6 hours";
// Short enough that signing in to `az` shows pictures without a server restart.
const AVATAR_FAILURE_TTL = "1 minute";
const GRAPH_API_VERSION = "7.1";

const GraphValueJson = Schema.fromJsonString(Schema.Struct({ value: Schema.String }));
const decodeGraphValue = Schema.decodeUnknownOption(GraphValueJson);

function sniffAvatarMimeType(bytes: Uint8Array): AzureDevOpsIdentityAvatar["mimeType"] | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return null;
}

export interface AzureCliInvocation {
  readonly command: string;
  /** Arguments `az` needs before the caller's, to run the CLI in UTF-8 mode. */
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `-X utf8` is the only way in: the launcher's `-I` implies `-E`, so `PYTHONUTF8` and
 * `PYTHONIOENCODING` are ignored, and the ANSI code page loses text `az` cannot encode.
 * Resolved once when the service is built: installing `az` later needs a restart.
 */
export const azureCliInvocation = Effect.fn("AzureDevOpsCli.invocation")(function* () {
  if ((yield* HostProcess.Platform) !== "win32") {
    return { command: "az", args: [] } satisfies AzureCliInvocation;
  }
  const resolveExecutable = yield* SpawnExecutableResolution;
  const launcher = resolveExecutable("az", "win32", yield* HostProcess.Environment);
  const installFor = yield* AzureCliInstallLocation;
  const install = launcher === undefined ? undefined : installFor(launcher);
  // Unrecognized installs (pipx's Scripts\az.exe) keep the launcher and today's decode.
  return install === undefined
    ? ({ command: "az", args: [] } satisfies AzureCliInvocation)
    : ({
        command: install.interpreter,
        args: ["-X", "utf8", "-IBm", "azure.cli"],
        // What the launcher sets before running this same interpreter.
        env: { AZ_INSTALLER: install.installer },
      } satisfies AzureCliInvocation);
});

/**
 * `--option=value` for free text. az replaces a value starting with `@` by that file's
 * contents; `@-` reads it from stdin instead, which reaches az wherever it runs (WSL included).
 */
export const textOption = (option: string, value: string) =>
  value.startsWith("@")
    ? { arg: `${option}=@-`, stdin: value }
    : { arg: `${option}=${value}`, stdin: undefined };

/** @public */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const invocation = yield* azureCliInvocation();

  const execute: AzureDevOpsCli["Service"]["execute"] = Effect.fn("AzureDevOpsCli.execute")(
    function* (input) {
      let args = input.args;
      if (detectsScope(args)) {
        // Windows az running in WSL cannot inspect the server's Linux checkout.
        const remoteUrl =
          input.remoteUrl ??
          (yield* process
            .run({
              operation: "AzureDevOpsCli.resolveScope",
              command: "git",
              args: ["remote", "-v"],
              cwd: input.cwd,
              env: {
                GIT_DIR: undefined,
                GIT_WORK_TREE: undefined,
                GIT_COMMON_DIR: undefined,
                GIT_INDEX_FILE: undefined,
                GIT_OBJECT_DIRECTORY: undefined,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
              },
              timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              maxOutputBytes: 64 * 1024,
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.map((remotes) =>
                remotes.exitCode === 0 && !remotes.stdoutTruncated && !remotes.stdoutInvalidUtf8
                  ? primaryRemoteUrl(remotes.stdout)
                  : null,
              ),
              Effect.orElseSucceed(() => null),
            ));
        if (remoteUrl !== null) args = scopeAzureCliArgs(args, remoteUrl);
      }
      return yield* process
        .run({
          operation: "AzureDevOpsCli.execute",
          command: invocation.command,
          args: [...invocation.args, ...args],
          cwd: input.cwd,
          ...(invocation.env === undefined ? {} : { env: invocation.env }),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          classifyFailure: classifyAzFailure,
          notFoundDetail: "Pull request not found.",
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
    },
  );

  const executeJson = (input: Parameters<AzureDevOpsCli["Service"]["execute"]>[0]) =>
    execute({
      ...input,
      args: [...input.args, "--only-show-errors", "--output", "json"],
    });

  // `az devops invoke` resolves the credential the same way every `az devops` command does:
  // `AZURE_DEVOPS_EXT_PAT`, then a PAT saved by `az devops login`, then the `az login` session.
  // The identity image URL itself only accepts a browser session, and the Graph avatar endpoint
  // wants a subject descriptor, which pull request reviewers do not carry.
  const invokeGraph = (input: {
    readonly cwd: string;
    readonly organizationUrl: string;
    readonly resource: "descriptors" | "avatars";
    readonly routeParameter: string;
    readonly queryParameters?: ReadonlyArray<string>;
  }) =>
    executeJson({
      cwd: input.cwd,
      args: [
        "devops",
        "invoke",
        "--org",
        input.organizationUrl,
        "--area",
        "graph",
        "--resource",
        input.resource,
        "--route-parameters",
        input.routeParameter,
        ...(input.queryParameters === undefined
          ? []
          : ["--query-parameters", ...input.queryParameters]),
        "--api-version",
        GRAPH_API_VERSION,
      ],
    }).pipe(
      Effect.map((result) => {
        const decoded = decodeGraphValue(result.stdout);
        return decoded._tag === "Some" ? decoded.value.value : null;
      }),
    );

  const avatarLookups = yield* Semaphore.make(MAX_AVATAR_LOOKUPS);
  const avatarCache = yield* Cache.makeWith(
    ({ cwd, identity }: Parameters<AzureDevOpsCli["Service"]["getIdentityAvatar"]>[0]) =>
      invokeGraph({
        cwd,
        organizationUrl: identity.organizationUrl,
        resource: "descriptors",
        routeParameter: `storageKey=${identity.identityId}`,
      }).pipe(
        Effect.flatMap((descriptor) =>
          descriptor === null
            ? Effect.succeed(null)
            : invokeGraph({
                cwd,
                organizationUrl: identity.organizationUrl,
                resource: "avatars",
                routeParameter: `subjectDescriptor=${descriptor}`,
                // 44 px. `large` is 220 px and about twenty times the bytes, for avatars drawn at
                // 14 to 32 px.
                queryParameters: ["size=medium"],
              }),
        ),
        Effect.map((encoded): AzureDevOpsIdentityAvatar | null => {
          if (encoded === null) return null;
          const bytes = Base64.decode(encoded);
          if (!Result.isSuccess(bytes)) return null;
          const mimeType = sniffAvatarMimeType(bytes.success);
          return mimeType === null ? null : { bytes: bytes.success, mimeType };
        }),
        avatarLookups.withPermits(1),
      ),
    {
      capacity: AVATAR_CACHE_CAPACITY,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? AVATAR_TTL : AVATAR_FAILURE_TTL,
    },
  );

  return AzureDevOpsCli.of({
    execute,
    listPullRequests: Effect.fn("AzureDevOpsCli.listPullRequests")(function (input) {
      const branch = SourceControlProvider.sourceBranch(input);
      // az checks literal ref prefixes before constructing the request URL.
      const refPrefix =
        ["refs/heads/", "refs/pull/", "refs/tags/"].find((prefix) => branch.startsWith(prefix)) ??
        "";
      return executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          // az puts this in the query string unescaped; a `#` would cut the request.
          refPrefix + encodeURIComponent(branch.slice(refPrefix.length)),
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
      );
    }),
    getPullRequest: Effect.fn("AzureDevOpsCli.getPullRequest")(function (input) {
      return executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
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
      );
    }),
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsCli.getRepositoryCloneUrls")(function (input) {
      const repository = parseRepositorySpecifier(input.repository);
      return executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: [
          "repos",
          "show",
          "--detect",
          "true",
          "--repository",
          repository.name,
          ...(repository.project ? ["--project", repository.project] : []),
        ],
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
      );
    }),
    createRepository: Effect.fn("AzureDevOpsCli.createRepository")(function (input) {
      const repository = parseRepositorySpecifier(input.repository);
      // Project/organization permissions control visibility; `az repos create` has no flag.
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
    }),
    createPullRequest: Effect.fn("AzureDevOpsCli.createPullRequest")(function (input) {
      // A full ref keeps a branch named `@...` from reading as a file; az accepts either form.
      const branch = (name: string) => (name.startsWith("@") ? `refs/heads/${name}` : name);
      const title = textOption("--title", input.title);
      return execute({
        cwd: input.cwd,
        ...remoteOf(input),
        args: [
          "repos",
          "pr",
          "create",
          "--only-show-errors",
          "--detect",
          "true",
          `--target-branch=${branch(input.target?.refName ?? input.baseBranch)}`,
          `--source-branch=${branch(SourceControlProvider.sourceBranch(input))}`,
          title.arg,
          // Joined: az expands a separate `@file` value again, so a body of `@path` read that file.
          `--description=@${input.bodyFile}`,
        ],
        ...(title.stdin === undefined ? {} : { stdin: title.stdin }),
      }).pipe(Effect.asVoid);
    }),
    getDefaultBranch: Effect.fn("AzureDevOpsCli.getDefaultBranch")(function (input) {
      const repository = parseRepositorySpecifier(input.repository);
      return executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: [
          "repos",
          "show",
          "--detect",
          "true",
          // Joined so a name starting with `-` stays the option's value.
          `--repository=${repository.name}`,
          ...(repository.project ? ["--project", repository.project] : []),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      );
    }),
    getIdentityAvatar: Effect.fn("AzureDevOpsCli.getIdentityAvatar")(function (input) {
      return Cache.get(avatarCache, {
        cwd: input.cwd,
        identity: {
          organizationUrl: input.identity.organizationUrl,
          identityId: input.identity.identityId,
        },
      });
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
