import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  ORIGIN_PULL_REQUEST_JSON_FIELDS,
  decodeOriginPullRequestJson,
  decodeOriginPullRequestListJson,
  originSshCloneUrl,
  originWebRepositoryUrl,
} from "./originPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const originCliFailureFields = {
  command: Schema.Literal("origin"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class OriginCliUnavailableError extends Schema.TaggedErrorClass<OriginCliUnavailableError>()(
  "OriginCliUnavailableError",
  originCliFailureFields,
) {
  get detail(): string {
    return "Origin CLI (`origin`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Origin CLI failed in execute: ${this.detail}`;
  }
}

export class OriginCliAuthenticationError extends Schema.TaggedErrorClass<OriginCliAuthenticationError>()(
  "OriginCliAuthenticationError",
  originCliFailureFields,
) {
  get detail(): string {
    return "Origin CLI is not authenticated. Run `origin auth login` and retry.";
  }

  override get message(): string {
    return `Origin CLI failed in execute: ${this.detail}`;
  }
}

export class OriginCliRateLimitError extends Schema.TaggedErrorClass<OriginCliRateLimitError>()(
  "OriginCliRateLimitError",
  originCliFailureFields,
) {
  get detail(): string {
    return "Origin API rate limit exceeded.";
  }

  override get message(): string {
    return `Origin CLI failed in execute: ${this.detail}`;
  }
}

export class OriginPullRequestNotFoundError extends Schema.TaggedErrorClass<OriginPullRequestNotFoundError>()(
  "OriginPullRequestNotFoundError",
  originCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `Origin CLI failed in execute: ${this.detail}`;
  }
}

export class OriginCliCommandError extends Schema.TaggedErrorClass<OriginCliCommandError>()(
  "OriginCliCommandError",
  originCliFailureFields,
) {
  get detail(): string {
    return "Origin CLI command failed.";
  }

  override get message(): string {
    return `Origin CLI failed in execute: ${this.detail}`;
  }
}

const originCliDecodeFields = {
  command: Schema.Literal("origin"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class OriginPullRequestListDecodeError extends Schema.TaggedErrorClass<OriginPullRequestListDecodeError>()(
  "OriginPullRequestListDecodeError",
  originCliDecodeFields,
) {
  get detail(): string {
    return "Origin CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `Origin CLI failed in listPullRequests: ${this.detail}`;
  }
}

export class OriginPullRequestDecodeError extends Schema.TaggedErrorClass<OriginPullRequestDecodeError>()(
  "OriginPullRequestDecodeError",
  originCliDecodeFields,
) {
  get detail(): string {
    return "Origin CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Origin CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class OriginRepositoryDecodeError extends Schema.TaggedErrorClass<OriginRepositoryDecodeError>()(
  "OriginRepositoryDecodeError",
  originCliDecodeFields,
) {
  get detail(): string {
    return "Origin CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Origin CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export const OriginCliError = Schema.Union([
  OriginCliUnavailableError,
  OriginCliAuthenticationError,
  OriginCliRateLimitError,
  OriginPullRequestNotFoundError,
  OriginCliCommandError,
  OriginPullRequestListDecodeError,
  OriginPullRequestDecodeError,
  OriginRepositoryDecodeError,
]);
export type OriginCliError = typeof OriginCliError.Type;

export const isOriginCliError = Schema.is(OriginCliError);

export function fromVcsError(
  context: {
    readonly command: "origin";
    readonly cwd: string;
  },
  error: VcsError,
): OriginCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new OriginCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new OriginCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "rate-limited") {
      return new OriginCliRateLimitError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new OriginPullRequestNotFoundError({ ...context, cause: error });
    }
  }

  return new OriginCliCommandError({ ...context, cause: error });
}

export interface OriginPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: Option.Option<DateTime.Utc>;
}

export interface OriginRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class OriginCli extends Context.Service<
  OriginCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, OriginCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
      readonly nameWithOwner?: string;
    }) => Effect.Effect<ReadonlyArray<OriginPullRequestSummary>, OriginCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly nameWithOwner?: string;
    }) => Effect.Effect<OriginPullRequestSummary, OriginCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<OriginRepositoryCloneUrls, OriginCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<OriginRepositoryCloneUrls, OriginCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, OriginCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, OriginCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, OriginCliError>;
  }
>()("t3/sourceControl/OriginCli") {}

const RawOriginRepositoryViewSchema = Schema.Struct({
  org: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
  fullName: Schema.optional(TrimmedNonEmptyString),
  cloneUrl: Schema.optional(TrimmedNonEmptyString),
  sshUrl: Schema.optional(TrimmedNonEmptyString),
  defaultBranch: Schema.optional(TrimmedNonEmptyString),
});
const decodeRawOriginRepositoryView = Schema.decodeEffect(
  Schema.fromJsonString(RawOriginRepositoryViewSchema),
);

function nameWithOwnerFromView(
  raw: Schema.Schema.Type<typeof RawOriginRepositoryViewSchema>,
  fallback: string,
): string {
  const fullName = raw.fullName?.trim();
  if (fullName && fullName.includes("/")) {
    return fullName;
  }
  const org = raw.org?.trim();
  const name = raw.name?.trim();
  if (org && name) {
    return `${org}/${name}`;
  }
  return fallback;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawOriginRepositoryViewSchema>,
  repository: string,
): OriginRepositoryCloneUrls {
  const nameWithOwner = nameWithOwnerFromView(raw, repository);
  return {
    nameWithOwner,
    url: originWebRepositoryUrl(nameWithOwner),
    sshUrl: raw.sshUrl ?? originSshCloneUrl(nameWithOwner),
  };
}

/**
 * `origin repo create` prints clone instructions on stdout. Prefer a parsed
 * owner/repo from an HTTPS URL when the CLI emits one; the returned `url` is
 * the Origin codebase page so "Open" lands on the product, not the git host.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): OriginRepositoryCloneUrls {
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/u, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length >= 2) {
        const nameWithOwner = `${segments.at(-2)}/${segments.at(-1)}`;
        return {
          nameWithOwner,
          url: originWebRepositoryUrl(nameWithOwner),
          sshUrl: originSshCloneUrl(nameWithOwner),
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: originWebRepositoryUrl(repository),
    sshUrl: originSshCloneUrl(repository),
  };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const execute: OriginCli["Service"]["execute"] = (input) =>
    process
      .run({
        operation: "OriginCli.execute",
        command: "origin",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(Effect.mapError((error) => fromVcsError({ command: "origin", cwd: input.cwd }, error)));

  return OriginCli.of({
    execute,
    listPullRequests: (input) =>
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
          String(input.limit ?? 20),
          "--json",
          ORIGIN_PULL_REQUEST_JSON_FIELDS,
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() =>
                decodeOriginPullRequestListJson(
                  raw,
                  input.nameWithOwner === undefined
                    ? undefined
                    : { nameWithOwner: input.nameWithOwner },
                ),
              ).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new OriginPullRequestListDecodeError({
                        command: "origin",
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
      execute({
        cwd: input.cwd,
        args: ["pr", "view", input.reference, "--json", ORIGIN_PULL_REQUEST_JSON_FIELDS],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() =>
            decodeOriginPullRequestJson(
              raw,
              input.nameWithOwner === undefined
                ? undefined
                : { nameWithOwner: input.nameWithOwner },
            ),
          ).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new OriginPullRequestDecodeError({
                    command: "origin",
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
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "org,name,fullName,cloneUrl,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawOriginRepositoryView(raw).pipe(
            Effect.mapError(
              (cause) =>
                new OriginRepositoryDecodeError({
                  command: "origin",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((raw) => normalizeRepositoryCloneUrls(raw, input.repository)),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        // Origin repositories are private to the codebase; the CLI has no
        // --public/--private flag, so requested visibility is ignored.
        args: ["repo", "create", input.repository],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
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
          "--status",
          "open",
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranch"],
      }).pipe(
        Effect.map((value) => value.stdout.trim()),
        Effect.flatMap((trimmed) => {
          if (trimmed.length === 0) {
            return Effect.succeed(null);
          }
          return decodeRawOriginRepositoryView(trimmed).pipe(
            Effect.map((raw) => {
              const branch = raw.defaultBranch?.trim() ?? "";
              return branch.length > 0 ? branch : null;
            }),
            Effect.orElseSucceed(() => (trimmed.startsWith("{") ? null : trimmed)),
          );
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(OriginCli, make);
