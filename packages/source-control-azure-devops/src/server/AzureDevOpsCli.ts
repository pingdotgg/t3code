import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off - az's own extension path layout, joined for the host platform.
import * as NodePath from "node:path";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
  type VcsProcessExitFailureKind,
} from "@t3tools/contracts";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { PullRequestCheckoutRemote } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AzureCliInstallLocation } from "./azureCliLauncher.ts";
import {
  decodeAzureDevOpsPullRequestJson,
  decodeAzureDevOpsPullRequestListJson,
  type NormalizedAzureDevOpsPullRequestRecord,
} from "./azureDevOpsPullRequests.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as AzureDevOpsCredentials from "./AzureDevOpsCredentials.ts";
import { azureDevOpsOrganizationKey } from "../shared/organization.ts";

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

export class AzureDevOpsSavedTokenUnreadableError extends Schema.TaggedError<AzureDevOpsSavedTokenUnreadableError>()(
  "AzureDevOpsSavedTokenUnreadableError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "The token saved for this organization could not be read from its secret provider. Unlock or fix it in Settings, then try again.";
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
  // No cause when the reference holds no pull request number and az never runs.
  { ...azureDevOpsCommandErrorFields, cause: Schema.optional(Schema.Defect()) },
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `Azure DevOps CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class AzureDevOpsRemoteDiscoveryError extends Schema.TaggedError<AzureDevOpsRemoteDiscoveryError>()(
  "AzureDevOpsRemoteDiscoveryError",
  azureDevOpsCommandErrorFields,
) {
  get detail(): string {
    return "The Azure DevOps remote could not be determined. Check the checkout and its git remotes, then retry.";
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
  AzureDevOpsSavedTokenUnreadableError,
  AzureDevOpsRemoteDiscoveryError,
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
    readonly resolveCheckoutRemote: (input: {
      readonly cwd: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<string | null, AzureDevOpsRemoteDiscoveryError>;
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      /** Undefined discovers a remote when needed. Null means discovery already found none. */
      readonly remoteUrl?: string | null;
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
      readonly draft?: boolean;
      readonly remoteUrl?: string;
    }) => Effect.Effect<void, AzureDevOpsCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<string | null, AzureDevOpsCliError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsCli") {}

/** The pull request number in `42`, `#42` or a pull request URL. */
function normalizeChangeRequestId(reference: string): string | null {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pullrequest|pull-request|pull|_pulls?)\/(\d+)(?:\D.*)?$/i.exec(trimmed);
  const id = urlMatch?.[1] ?? trimmed;
  return /^\d+$/.test(id) ? id : null;
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

const RawAzureDevOpsProjectSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)),
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

function parseCheckoutRemotes(output: string) {
  if (output !== "" && !output.endsWith("\n")) return null;
  const fetch = new Map<string, string>();
  const push = new Map<string, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\t(\S+(?: +\S+)*?) \((fetch|push)\)(?: \[[^[\]]+\])?$/u.exec(trimmed);
    if (!match?.[1] || !match[2]) return null;
    const urls = match[3] === "fetch" ? fetch : push;
    if (!urls.has(match[1])) urls.set(match[1], match[2]);
  }
  return { fetch, push };
}

function selectCheckoutRemote({
  fetch,
  push,
}: NonNullable<ReturnType<typeof parseCheckoutRemotes>>) {
  // T3 scopes to origin's fetch remote when it can. Otherwise follow the extension's detection:
  // origin's push remote if it looks like Azure DevOps, then the first other one that does.
  const origin = fetch.get("origin");
  if (origin !== undefined && scopeFromRemoteUrl(origin) !== null) return origin;
  const originPush = push.get("origin");
  if (originPush !== undefined && isAzCandidate(originPush)) return originPush;
  return (
    [...push.values()].find(isAzCandidate) ??
    origin ??
    [...fetch.values()].find((url) => scopeFromRemoteUrl(url) !== null) ??
    null
  );
}

/** The remote that scopes `az` when T3 selected none, from `git remote -v` output. */
export function primaryRemoteUrl(output: string) {
  const remotes = parseCheckoutRemotes(output);
  return remotes === null ? null : selectCheckoutRemote(remotes);
}

// The extension's `is_vsts_url_candidate`, with Python's `urlparse` reduced to what it checks.
const isAzCandidate = (url: string): boolean => {
  let lower = url.toLowerCase();
  // `uri_parse` gives the newer SSH remotes, which lack a scheme, one.
  if (
    !lower.startsWith("ssh:") &&
    (lower.includes("vs-ssh.visualstudio.com") || lower.includes("ssh.dev.azure.com"))
  ) {
    lower = `ssh://${lower}`;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(lower)?.[1] ?? "";
  const rest = scheme.length === 0 ? lower : lower.slice(scheme.length + 1);
  const authority = rest.startsWith("//") ? (/^\/\/([^/?#]*)/.exec(rest)?.[1] ?? "") : null;
  if (authority === "github.com") return false;
  const path =
    (authority === null ? rest : rest.slice(authority.length + 2)).split(/[?#]/)[0] ?? "";
  return path.includes("/_git/") || path.includes("/_ssh/") || scheme === "ssh";
};

function scopeFromRemoteUrl(remote: string) {
  try {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(remote);
    const url = new URL(
      remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : remote,
    );
    const legacy = url.hostname.endsWith(".visualstudio.com");
    const parts = url.pathname.replace(/\/$/u, "").slice(1).split("/").map(decodeURIComponent);
    let organization: string | undefined;
    if (
      url.protocol === "ssh:" &&
      (url.hostname === "ssh.dev.azure.com" || url.hostname === "vs-ssh.visualstudio.com")
    ) {
      if (parts.length !== 4 || parts.shift() !== "v3") return null;
      organization = parts.shift();
    } else if (url.protocol === "https:" && url.port === "") {
      if (url.hostname === "dev.azure.com") organization = parts.shift();
      else {
        organization = /^([^.]+)\.visualstudio\.com$/u.exec(url.hostname)?.[1];
        if (!organization) return null;
        if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift();
      }
      if (parts.length === 2 && parts[0] === "_git" && parts[1]) parts.unshift(parts[1]);
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

function organizationArg(args: ReadonlyArray<string>): string | undefined {
  const index = args.findIndex((arg) => /^(?:--organization|--org)(?:=|$)/u.test(arg));
  if (index === -1) return undefined;
  const arg = args[index]!;
  const equals = arg.indexOf("=");
  return equals === -1 ? args[index + 1] : arg.slice(equals + 1);
}

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
  const env = yield* HostProcess.Environment;
  const launcher = yield* Effect.promise(async () => resolveExecutable("az", "win32", env));
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
  const credentials = yield* AzureDevOpsCredentials.AzureDevOpsCredentials;
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const environment = yield* HostProcess.Environment;
  const extensionDir =
    environment.AZURE_EXTENSION_DIR ||
    NodePath.join(
      environment.AZURE_CONFIG_DIR || NodePath.join(yield* HostProcess.HomeDirectory, ".azure"),
      "cliextensions",
    );

  // The extension tries every az login account before AZURE_DEVOPS_EXT_PAT, so a run with a
  // saved token gets a config directory with no accounts. It keeps the user's extensions.
  const configDirLock = yield* Semaphore.make(1);
  let configDir: string | undefined;
  const isolatedConfigDir = configDirLock.withPermit(
    Effect.suspend(() =>
      configDir !== undefined
        ? Effect.succeed(configDir)
        : fileSystem.makeTempDirectoryScoped({ prefix: "t3code-az-" }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tap((directory) => Effect.sync(() => (configDir = directory))),
          ),
    ),
  );

  const invocation = yield* azureCliInvocation();

  const resolveCheckoutRemote: AzureDevOpsCli["Service"]["resolveCheckoutRemote"] = Effect.fn(
    "AzureDevOpsCli.resolveCheckoutRemote",
  )(function* (input) {
    const failed = (cause: unknown) =>
      new AzureDevOpsRemoteDiscoveryError({
        operation: "execute",
        command: "az",
        cwd: input.cwd,
        argumentCount: 0,
        cause,
      });
    // Windows az running in WSL cannot inspect the server's Linux checkout.
    const result = yield* process
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
      })
      .pipe(Effect.mapError(failed));
    const remotes =
      result.exitCode === 0 && !result.stdoutTruncated && !result.stdoutInvalidUtf8
        ? parseCheckoutRemotes(result.stdout)
        : null;
    if (remotes === null) return yield* failed("git remote output was incomplete or invalid");
    return selectCheckoutRemote(remotes);
  });

  const execute: AzureDevOpsCli["Service"]["execute"] = Effect.fn("AzureDevOpsCli.execute")(
    function* (input) {
      const context = {
        operation: "execute",
        command: "az",
        cwd: input.cwd,
        argumentCount: input.args.length,
      } as const;
      const detect = detectsScope(input.args);
      const remoteUrl =
        input.remoteUrl !== undefined
          ? input.remoteUrl
          : detect
            ? ((yield* PullRequestCheckoutRemote) ?? (yield* resolveCheckoutRemote(input)))
            : null;
      const args = remoteUrl === null ? input.args : scopeAzureCliArgs(input.args, remoteUrl);
      if (
        detect &&
        args === input.args &&
        remoteUrl !== null &&
        azureDevOpsOrganizationKey(remoteUrl) !== null
      ) {
        return yield* new AzureDevOpsRemoteDiscoveryError({
          ...context,
          cause: "The selected Azure DevOps remote cannot scope this command",
        });
      }
      const organization = organizationArg(args);
      const saved =
        organization === undefined
          ? Option.none()
          : yield* credentials
              .savedToken(organization)
              .pipe(
                Effect.mapError(
                  (cause) => new AzureDevOpsSavedTokenUnreadableError({ ...context, cause }),
                ),
              );
      const credentialEnv = Option.isNone(saved)
        ? undefined
        : {
            AZURE_CONFIG_DIR: yield* isolatedConfigDir.pipe(
              Effect.mapError((cause) => new AzureDevOpsCommandFailedError({ ...context, cause })),
            ),
            AZURE_EXTENSION_DIR: extensionDir,
            AZURE_DEVOPS_EXT_PAT: Redacted.value(saved.value),
          };
      const env =
        invocation.env === undefined && credentialEnv === undefined
          ? undefined
          : { ...invocation.env, ...credentialEnv };
      return yield* process
        .run({
          operation: "AzureDevOpsCli.execute",
          command: invocation.command,
          args: [...invocation.args, ...args],
          cwd: input.cwd,
          ...(env === undefined ? {} : { env }),
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

  /** The options naming a `project/name` repository, each a `textOption` so neither reads a file. */
  const repositoryOptions = Effect.fn("AzureDevOpsCli.repositoryOptions")(function* (
    input: { readonly cwd: string; readonly repository: string; readonly remoteUrl?: string },
    nameOption: "--repository" | "--name",
    operation: typeof AzureDevOpsRepositoryDecodeOperation.Type,
  ) {
    const repository = parseRepositorySpecifier(input.repository);
    const name = textOption(nameOption, repository.name);
    if (repository.project === null) return { args: [name.arg], stdin: name.stdin };
    const project = textOption("--project", repository.project);
    if (name.stdin === undefined || project.stdin === undefined) {
      return { args: [name.arg, project.arg], stdin: name.stdin ?? project.stdin };
    }
    // az has one stdin, so the project is read in a call of its own and named by its ID here.
    const { id } = yield* executeJson({
      cwd: input.cwd,
      ...remoteOf(input),
      args: ["devops", "project", "show", "--detect", "true", project.arg],
      stdin: project.stdin,
    }).pipe(
      Effect.flatMap((result) =>
        decodeAzureDevOpsJson(
          result.stdout.trim(),
          RawAzureDevOpsProjectSchema,
          operation,
          input.cwd,
        ),
      ),
    );
    return { args: [name.arg, `--project=${id}`], stdin: name.stdin };
  });

  return AzureDevOpsCli.of({
    resolveCheckoutRemote,
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
          // az puts this in the query string unescaped; a `#` would cut the request. Encoding
          // also turns a leading `@` into `%40`; joined so a leading `-` stays the value.
          `--source-branch=${refPrefix + encodeURIComponent(branch.slice(refPrefix.length))}`,
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
      const id = normalizeChangeRequestId(input.reference);
      if (id === null) {
        // az takes only a number here, and would read `@path` as a file and `-x` as an option.
        return Effect.fail(
          new AzureDevOpsPullRequestNotFoundError({
            operation: "execute",
            command: "az",
            cwd: input.cwd,
            argumentCount: 0,
          }),
        );
      }
      return executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: ["repos", "pr", "show", "--detect", "true", "--id", id],
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
    getRepositoryCloneUrls: Effect.fn("AzureDevOpsCli.getRepositoryCloneUrls")(function* (input) {
      const repository = yield* repositoryOptions(input, "--repository", "getRepositoryCloneUrls");
      return yield* executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: ["repos", "show", "--detect", "true", ...repository.args],
        ...(repository.stdin === undefined ? {} : { stdin: repository.stdin }),
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
    createRepository: Effect.fn("AzureDevOpsCli.createRepository")(function* (input) {
      const repository = yield* repositoryOptions(input, "--name", "createRepository");
      // Project/organization permissions control visibility; `az repos create` has no flag.
      return yield* executeJson({
        cwd: input.cwd,
        args: ["repos", "create", "--detect", "true", ...repository.args],
        ...(repository.stdin === undefined ? {} : { stdin: repository.stdin }),
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
          ...(input.draft === true ? ["--draft", "true"] : []),
        ],
        ...(title.stdin === undefined ? {} : { stdin: title.stdin }),
      }).pipe(Effect.asVoid);
    }),
    getDefaultBranch: Effect.fn("AzureDevOpsCli.getDefaultBranch")(function* (input) {
      const repository = yield* repositoryOptions(input, "--repository", "getDefaultBranch");
      return yield* executeJson({
        cwd: input.cwd,
        ...remoteOf(input),
        args: ["repos", "show", "--detect", "true", ...repository.args],
        ...(repository.stdin === undefined ? {} : { stdin: repository.stdin }),
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeAzureDevOpsJson(raw, RawAzureDevOpsRepositorySchema, "getDefaultBranch", input.cwd),
        ),
        Effect.map((repo) => normalizeDefaultBranch(repo.defaultBranch)),
      );
    }),
  });
});

export const layer = Layer.effect(AzureDevOpsCli, make);
