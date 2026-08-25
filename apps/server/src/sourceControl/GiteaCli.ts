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
import { decodeGiteaPullRequestJson, decodeGiteaPullRequestListJson } from "./giteaPullRequests.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Gitea's list endpoint cannot filter by head branch, so T3 filters client side. Pages are capped
 * so a repository with a long PR history cannot turn one status refresh into unbounded requests.
 */
const LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGES = 5;

const giteaCliExecutionErrorContext = {
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  status: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
};

const giteaCliDecodeErrorContext = {
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class GiteaCliUnavailableError extends Schema.TaggedErrorClass<GiteaCliUnavailableError>()(
  "GiteaCliUnavailableError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI (`tea`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export class GiteaCliAuthenticationError extends Schema.TaggedErrorClass<GiteaCliAuthenticationError>()(
  "GiteaCliAuthenticationError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI is not authenticated for this instance. Run `tea login add` and retry.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export class GiteaCliRateLimitError extends Schema.TaggedErrorClass<GiteaCliRateLimitError>()(
  "GiteaCliRateLimitError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea API rate limit exceeded.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export class GiteaPullRequestNotFoundError extends Schema.TaggedErrorClass<GiteaPullRequestNotFoundError>()(
  "GiteaPullRequestNotFoundError",
  {
    ...giteaCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the PR number or URL and try again.`;
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly command: "tea";
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): GiteaCliError {
    if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
      return new GiteaPullRequestNotFoundError({ ...context, cause: error });
    }

    return GiteaCliCommandError.fromVcsError({ command: context.command, cwd: context.cwd }, error);
  }
}

export class GiteaCliCommandError extends Schema.TaggedErrorClass<GiteaCliCommandError>()(
  "GiteaCliCommandError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI command failed.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly command: "tea";
      readonly cwd: string;
    },
    error: VcsError,
  ): GiteaCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => {
        if (isSpawnNotFound(cause)) {
          return new GiteaCliUnavailableError({ ...context, cause });
        }
        return new GiteaCliCommandError({ ...context, cause });
      },
      VcsProcessExitError: (cause) => {
        switch (cause.failureKind) {
          case "authentication":
            return new GiteaCliAuthenticationError({ ...context, cause });
          case "rate-limited":
            return new GiteaCliRateLimitError({ ...context, cause });
          case "not-found":
          case "command-failed":
          case undefined:
            return new GiteaCliCommandError({ ...context, cause });
        }
      },
      VcsProcessTimeoutError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new GiteaCliCommandError({ ...context, cause }),
    });
  }
}

export class GiteaPullRequestListDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestListDecodeError>()(
  "GiteaPullRequestListDecodeError",
  giteaCliDecodeErrorContext,
) {
  get detail(): string {
    return "Gitea CLI returned invalid pull request list JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export class GiteaPullRequestDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestDecodeError>()(
  "GiteaPullRequestDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literals(["getPullRequest", "createPullRequest"]),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export class GiteaRepositoryDecodeError extends Schema.TaggedErrorClass<GiteaRepositoryDecodeError>()(
  "GiteaRepositoryDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository", "getDefaultBranch"]),
    repository: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed: ${this.detail}`;
  }
}

export const GiteaCliError = Schema.Union([
  GiteaCliUnavailableError,
  GiteaCliAuthenticationError,
  GiteaCliRateLimitError,
  GiteaPullRequestNotFoundError,
  GiteaCliCommandError,
  GiteaPullRequestListDecodeError,
  GiteaPullRequestDecodeError,
  GiteaRepositoryDecodeError,
]);
export type GiteaCliError = typeof GiteaCliError.Type;
export const isGiteaCliError = Schema.is(GiteaCliError);

export interface GiteaPullRequestSummary {
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

export interface GiteaRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export class GiteaCli extends Context.Service<
  GiteaCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      /** Piped to the child's stdin, for payloads that must never appear in argv. */
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GiteaCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GiteaPullRequestSummary>, GiteaCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GiteaPullRequestSummary, GiteaCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GiteaCliError>;

    readonly getDefaultBranch: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | null, GiteaCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GiteaCliError>;
  }
>()("t3/sourceControl/GiteaCli") {}

const RawGiteaRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  clone_url: TrimmedNonEmptyString,
  ssh_url: TrimmedNonEmptyString,
});

/** `GET /user`. Gitea reports the account name as `login`; older builds also send `username`. */
const RawGiteaUserSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  username: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const RawGiteaDefaultBranchSchema = Schema.Struct({
  default_branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const decodeGiteaRepository = Schema.decodeEffect(Schema.fromJsonString(RawGiteaRepositorySchema));
const decodeGiteaDefaultBranch = Schema.decodeEffect(
  Schema.fromJsonString(RawGiteaDefaultBranchSchema),
);
const decodeGiteaUser = Schema.decodeEffect(Schema.fromJsonString(RawGiteaUserSchema));

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGiteaRepositorySchema>,
): GiteaRepositoryCloneUrls {
  return {
    nameWithOwner: raw.full_name,
    // clone_url, not html_url: this value is handed to git as the remote for HTTPS clones.
    url: raw.clone_url,
    sshUrl: raw.ssh_url,
  };
}

/**
 * `tea api` exits 0 even for HTTP 4xx and prints the status line to stderr under `-i`, so failures
 * have to be read off the response rather than the exit code.
 */
const HTTP_STATUS_LINE_PATTERN = /^HTTP\/[\d.]+\s+(\d{3})\b/gmu;

export function parseHttpStatusCode(stderr: string): number | null {
  let status: number | null = null;
  // Redirects emit several status lines; the last one describes the response actually returned.
  for (const match of stderr.matchAll(HTTP_STATUS_LINE_PATTERN)) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) status = parsed;
  }
  return status;
}

/** Detects a spawn failure caused by a missing executable (ENOENT). */
function isSpawnNotFound(cause: unknown): boolean {
  if (!isNonErrorDefect(cause)) {
    return false;
  }

  return hasEnoentCode(cause) || ENOENT_MESSAGE.test(cause.message) || isNestedEnoent(cause);
}

const ENOENT_MESSAGE = /ENOENT|no such file or directory/iu;

function isNonErrorDefect(cause: unknown): cause is Error {
  return cause instanceof Error;
}

function hasEnoentCode(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNestedEnoent(error: Error): boolean {
  const inner = (error as { readonly cause?: unknown }).cause;
  if (!isNonErrorDefect(inner)) {
    return false;
  }
  return hasEnoentCode(inner) || ENOENT_MESSAGE.test(inner.message) || isNestedEnoent(inner);
}

function httpStatusFailure(
  status: number,
  context: { readonly cwd: string; readonly reference?: string },
): GiteaCliError {
  const base = { command: "tea", cwd: context.cwd, status } as const;

  if (status === 401 || status === 403) {
    return new GiteaCliAuthenticationError(base);
  }
  if (status === 429) {
    return new GiteaCliRateLimitError(base);
  }
  if (status === 404 && context.reference !== undefined) {
    return new GiteaPullRequestNotFoundError({ ...base, reference: context.reference });
  }
  return new GiteaCliCommandError(base);
}

function repositoryEndpoint(repository: string): string {
  const segments = repository
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return `repos/${segments.join("/")}`;
}

export interface GiteaPullRequestReference {
  /** The PR index within its repository. */
  readonly index: string;
  /** Present when the reference was a full URL pointing at a specific repository. */
  readonly repository?: string;
}

/**
 * Accepts a bare index (`42`, `#42`) or a Gitea PR URL on any host, since self-hosted instances
 * live on arbitrary hostnames: https://HOST/OWNER/REPO/pulls/42.
 */
export function parseGiteaPullRequestReference(
  reference: string,
): GiteaPullRequestReference | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;

  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (bare?.[1]) return { index: bare[1] };

  let path: string;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    return null;
  }

  const url = /^\/([^/]+)\/([^/]+)\/pulls?\/(\d+)\/?$/u.exec(path);
  const owner = url?.[1];
  const repo = url?.[2];
  const index = url?.[3];
  if (!owner || !repo || !index) return null;

  try {
    return { index, repository: `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}` };
  } catch {
    return null;
  }
}

/** The endpoint prefix for a reference: an explicit repo from a URL, or the repo in cwd. */
function referenceRepositoryEndpoint(reference: GiteaPullRequestReference): string {
  return reference.repository === undefined
    ? "repos/{owner}/{repo}"
    : repositoryEndpoint(reference.repository);
}

/** Gitea exposes only open/closed/all; merged is a closed PR carrying `merged: true`. */
function listStateParameter(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
    case "merged":
      return "closed";
    case "all":
      return "all";
  }
}

function matchesRequestedState(
  summary: GiteaPullRequestSummary,
  state: "open" | "closed" | "merged" | "all",
): boolean {
  switch (state) {
    case "all":
      return true;
    case "open":
      return summary.state === "open";
    case "closed":
      // T3 treats merged as its own state, so a merged PR is not a "closed" result.
      return summary.state === "closed";
    case "merged":
      return summary.state === "merged";
  }
}

function normalizeHeadSelector(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerBranch = /^[^:]+:(.+)$/u.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

/** Gitea expresses a fork head as `owner:branch`, matching T3's own head selector syntax. */
function headParameter(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  const refName = sourceRefName(input);
  const owner = input.source?.owner;
  return owner ? `${owner}:${refName}` : refName;
}

function toSummaryWithOptionalUpdatedAt(
  record: GiteaPullRequestSummary & { readonly updatedAt: Option.Option<DateTime.Utc> },
): GiteaPullRequestSummary {
  const { updatedAt, ...summary } = record;
  return Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

function parseRepositoryPath(repository: string): {
  readonly owner: string | null;
  readonly name: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  const name = parts.at(-1) ?? repository.trim();
  const owner = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { owner, name };
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const run = (
    input: Parameters<GiteaCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => GiteaCliError,
  ) =>
    process
      .run({
        operation: "GiteaCli.execute",
        command: "tea",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError(mapError));

  const execute: GiteaCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      GiteaCliCommandError.fromVcsError({ command: "tea", cwd: input.cwd }, error),
    );

  /**
   * Runs a `tea api` call and converts an HTTP error status into a typed failure. Every API call
   * goes through here so a 401 or 404 can never be mistaken for an empty result.
   */
  const api = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly reference?: string;
    readonly maxOutputBytes?: number;
  }) =>
    execute({
      cwd: input.cwd,
      args: ["api", "-i", ...input.args],
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
    }).pipe(
      Effect.flatMap((result) => {
        const status = parseHttpStatusCode(result.stderr);
        if (status !== null && status >= 400) {
          return Effect.fail(
            httpStatusFailure(status, {
              cwd: input.cwd,
              ...(input.reference === undefined ? {} : { reference: input.reference }),
            }),
          );
        }
        return Effect.succeed(result.stdout.trim());
      }),
    );

  const listPage = (input: {
    readonly cwd: string;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly page: number;
  }) =>
    api({
      cwd: input.cwd,
      args: [
        `repos/{owner}/{repo}/pulls?state=${listStateParameter(input.state)}&sort=recentupdate&limit=${LIST_PAGE_SIZE}&page=${input.page}`,
      ],
    }).pipe(
      Effect.flatMap((raw) => {
        if (raw.length === 0) {
          return Effect.succeed({
            entries: [] as ReadonlyArray<GiteaPullRequestSummary>,
            rawCount: 0,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          return Effect.fail(
            new GiteaPullRequestListDecodeError({
              command: "tea",
              cwd: input.cwd,
              cause: error,
            }),
          );
        }
        const rawCount = Array.isArray(parsed) ? parsed.length : 0;
        return Effect.sync(() => decodeGiteaPullRequestListJson(raw)).pipe(
          Effect.flatMap((decoded) =>
            Result.isSuccess(decoded)
              ? Effect.succeed({
                  entries: decoded.success.map(toSummaryWithOptionalUpdatedAt),
                  rawCount,
                })
              : Effect.fail(
                  new GiteaPullRequestListDecodeError({
                    command: "tea",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                ),
          ),
        );
      }),
    );

  return GiteaCli.of({
    execute,
    /**
     * Gitea's list endpoint has no head-branch filter, so pages are walked and matched locally.
     * The common case costs one request: page one is usually short, and the walk stops as soon as
     * enough matches are found or a partial page proves the list is exhausted.
     */
    listPullRequests: (input) =>
      Effect.gen(function* () {
        const wanted = input.limit ?? 20;
        const headRefName = sourceRefName(input);
        const sourceOwner = input.source?.owner?.toLowerCase() ?? null;
        const matches: Array<GiteaPullRequestSummary> = [];

        for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
          const { entries, rawCount } = yield* listPage({
            cwd: input.cwd,
            state: input.state,
            page,
          });

          for (const entry of entries) {
            if (
              entry.headRefName === headRefName &&
              matchesRequestedState(entry, input.state) &&
              (sourceOwner === null ||
                entry.headRepositoryOwnerLogin?.toLowerCase() === sourceOwner)
            ) {
              matches.push(entry);
            }
          }

          if (matches.length >= wanted || rawCount < LIST_PAGE_SIZE) break;
        }

        return matches.slice(0, wanted);
      }),
    getPullRequest: (input) =>
      Effect.gen(function* () {
        const reference = parseGiteaPullRequestReference(input.reference);
        if (reference === null) {
          return yield* Effect.fail(
            new GiteaPullRequestNotFoundError({
              command: "tea",
              cwd: input.cwd,
              reference: input.reference,
            }),
          );
        }

        const raw = yield* api({
          cwd: input.cwd,
          reference: input.reference,
          args: [`${referenceRepositoryEndpoint(reference)}/pulls/${reference.index}`],
        });

        const decoded = decodeGiteaPullRequestJson(raw);
        if (!Result.isSuccess(decoded)) {
          return yield* Effect.fail(
            new GiteaPullRequestDecodeError({
              operation: "getPullRequest",
              command: "tea",
              cwd: input.cwd,
              reference: input.reference,
              cause: decoded.failure,
            }),
          );
        }
        return toSummaryWithOptionalUpdatedAt(decoded.success);
      }),
    getRepositoryCloneUrls: (input) =>
      api({ cwd: input.cwd, args: [repositoryEndpoint(input.repository)] }).pipe(
        Effect.flatMap((raw) =>
          decodeGiteaRepository(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GiteaRepositoryDecodeError({
                  operation: "getRepositoryCloneUrls",
                  command: "tea",
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
      const { owner, name } = parseRepositoryPath(input.repository);

      /**
       * Gitea splits repository creation in two: `POST /user/repos` creates under the authenticated
       * user, while `POST /orgs/{org}/repos` requires a real organization and 404s for a plain
       * user. T3's publish dialog prefills the signed-in account as the owner, so the common input
       * is `<you>/name` — sending that to the orgs endpoint would fail every default publish.
       * Resolve who we are and pick accordingly.
       */
      const endpoint: Effect.Effect<string, GiteaCliError> =
        owner === null
          ? Effect.succeed("user/repos")
          : api({ cwd: input.cwd, args: ["user"] }).pipe(
              Effect.flatMap((raw) =>
                decodeGiteaUser(raw).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GiteaRepositoryDecodeError({
                        operation: "createRepository",
                        command: "tea",
                        cwd: input.cwd,
                        repository: input.repository,
                        cause,
                      }),
                  ),
                ),
              ),
              Effect.map((user) => {
                const login = user.login ?? user.username ?? null;
                return login !== null && login.toLowerCase() === owner.toLowerCase()
                  ? "user/repos"
                  : `orgs/${encodeURIComponent(owner)}/repos`;
              }),
            );

      return endpoint.pipe(
        Effect.flatMap((resolvedEndpoint) =>
          api({
            cwd: input.cwd,
            args: [
              "-X",
              "POST",
              resolvedEndpoint,
              "-f",
              `name=${name}`,
              "-F",
              `private=${input.visibility === "private"}`,
            ],
          }),
        ),
        Effect.flatMap((raw) =>
          decodeGiteaRepository(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GiteaRepositoryDecodeError({
                  operation: "createRepository",
                  command: "tea",
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
    createPullRequest: (input) =>
      api({
        cwd: input.cwd,
        args: [
          "-X",
          "POST",
          "repos/{owner}/{repo}/pulls",
          "-f",
          `head=${headParameter(input)}`,
          "-f",
          `base=${input.target?.refName ?? input.baseBranch}`,
          "-f",
          `title=${input.title}`,
          // `-F key=@file` reads the file and always encodes it as a JSON string, so a body that
          // happens to start with `{` stays a body and never becomes argv.
          "-F",
          `body=@${input.bodyFile}`,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      api({ cwd: input.cwd, args: ["repos/{owner}/{repo}"] }).pipe(
        Effect.flatMap((raw) =>
          decodeGiteaDefaultBranch(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GiteaRepositoryDecodeError({
                  operation: "getDefaultBranch",
                  command: "tea",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((value) => value.default_branch ?? null),
      ),
    // `tea pulls checkout` is a real subcommand that exits non-zero on failure, so it keeps the
    // ordinary exit-code error mapping instead of the `tea api` status handling.
    checkoutPullRequest: (input) =>
      run(
        {
          cwd: input.cwd,
          args: [
            "pulls",
            "checkout",
            parseGiteaPullRequestReference(input.reference)?.index ?? input.reference,
            "--branch",
            ...(input.force ? ["--force"] : []),
          ],
        },
        (error) =>
          GiteaPullRequestNotFoundError.fromVcsError(
            {
              command: "tea",
              cwd: input.cwd,
              reference: input.reference,
            },
            error,
          ),
      ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GiteaCli, make);
