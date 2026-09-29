import { Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import {
  isGitHubRateLimitMessage,
  rewriteGitHubRateLimitDetail,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import { runProcess } from "../../processRunner.ts";
import { GitHubApiUsage } from "../../gitHubUsage/GitHubApiUsage.ts";
import {
  classifyResolvedOutcome,
  parseGhCooldown,
  parseGhDebugTelemetry,
  stripGhDebugLines,
  summarizeGhArgs,
} from "../../gitHubUsage/ghDebugTelemetry.ts";
import { GitHubCliError } from "@t3tools/contracts";
import {
  GitHubCli,
  type GitHubPullRequestSummary,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
} from "../Services/GitHubCli.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
  formatGitHubJsonDecodeError,
} from "../githubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The process runner joins a failure's stderr onto one `<argv> <reason>.`
 * first line, so the first `* Request to …` trace line — and every
 * rate-limit header after it — is invisible to line-anchored parsing, and the
 * argv plus one debug fragment survive debug-line stripping. Recover the raw
 * stderr with the exact argv this call ran with. Anything without that prefix
 * (spawn errors, raw stderr handed in directly) passes through untouched.
 */
export function splitRunnerMessage(
  message: string,
  args: readonly string[],
): {
  readonly stderr: string;
  readonly timedOut: boolean;
} {
  const label = ["gh", ...args].join(" ");
  if (!message.startsWith(label)) return { stderr: message, timedOut: false };
  const rest = message.slice(label.length);
  if (rest.startsWith(" timed out.")) {
    const stderr = rest.slice(" timed out.".length);
    return { stderr: stderr.startsWith(" ") ? stderr.slice(1) : stderr, timedOut: true };
  }
  const match = /^ failed \([^)]*\)\.([\s\S]*)$/.exec(rest);
  if (!match) return { stderr: message, timedOut: false };
  const stderr = match[1] ?? "";
  return { stderr: stderr.startsWith(" ") ? stderr.slice(1) : stderr, timedOut: false };
}

function retryAfterAtFromMessage(message: string): string | undefined {
  // Trace header lines carry a `< ` prefix, which bare-message parsing misses.
  const retryAfter = /(?:^|\r?\n)\s*(?:[<>]\s*)?retry-after\s*:\s*([^\r\n]+)/iu
    .exec(message)?.[1]
    ?.trim();
  const resetAt = /(?:^|\r?\n)\s*(?:[<>]\s*)?x-ratelimit-reset\s*:\s*(\d+)/iu.exec(message)?.[1];
  const retryAt =
    retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter)
      ? Date.now() + Number(retryAfter) * 1_000
      : retryAfter
        ? Date.parse(retryAfter)
        : resetAt
          ? Number(resetAt) * 1_000
          : Number.NaN;
  return Number.isFinite(retryAt) ? new Date(retryAt).toISOString() : undefined;
}

function normalizeGitHubCliError(
  operation: "execute" | "stdout",
  error: unknown,
  args?: readonly string[],
): GitHubCliError {
  if (error instanceof Error) {
    // Sanitize once: the raw message can carry the debug trace and dumped
    // bodies, and `cause` travels over RPC inside Schema.Unknown — so the
    // retained cause must be the cleaned text, never the original error.
    // Classification runs on the same cleaned text, which keeps rate-limit
    // and not-found signals while dropping body-driven false positives.
    const { stderr, timedOut } =
      args === undefined
        ? { stderr: error.message, timedOut: false }
        : splitRunnerMessage(error.message, args);
    const cleaned = stripGhDebugLines(stderr);
    const safeCause = new Error(
      cleaned.length > 0
        ? cleaned
        : timedOut
          ? "GitHub CLI command failed: timed out."
          : "GitHub CLI command failed.",
    );
    if (cleaned.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: safeCause,
      });
    }

    const lower = cleaned.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: safeCause,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: safeCause,
      });
    }

    const retryAfterAt = retryAfterAtFromMessage(stderr);
    return new GitHubCliError({
      operation,
      // An exhausted quota fails every call identically until the reset, so say that once in
      // stable words the PR caches and the client can match on — instead of echoing the raw
      // `gh` argv and stderr on every failure.
      detail: rewriteGitHubRateLimitDetail(
        cleaned.length > 0
          ? `GitHub CLI command failed: ${cleaned}`
          : timedOut
            ? "GitHub CLI command failed: timed out."
            : "GitHub CLI command failed.",
      ),
      ...(retryAfterAt ? { retryAfterAt } : {}),
      cause: safeCause,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

const PULL_REQUEST_BY_URL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      baseRefName
      headRefName
      headRefOid
      state
      mergedAt
      isCrossRepository
      headRepository { nameWithOwner }
      headRepositoryOwner { login }
    }
  }
}`;

function explicitPullRequestUrl(reference: string): {
  readonly hostname: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
} | null {
  try {
    const url = new URL(reference);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const path = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u.exec(url.pathname);
    if (!path) return null;
    const owner = decodeURIComponent(path[1]!);
    const repository = decodeURIComponent(path[2]!);
    if (
      !/^[\w.-]+$/u.test(owner) ||
      !/^[\w.-]+$/u.test(repository) ||
      !/^[a-zA-Z0-9.-]+$/u.test(url.hostname)
    ) {
      return null;
    }
    const number = Number(path[3]);
    return Number.isSafeInteger(number)
      ? { hostname: url.hostname, owner, repository, number }
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIncludedApiResponse(raw: string): {
  readonly status: number;
  readonly body: string;
  readonly retryAfterAt: string | undefined;
} | null {
  const blocks = Array.from(
    raw.matchAll(/^HTTP\/\S+\s+(\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/gimu),
  );
  const block = blocks.at(-1);
  if (!block || block.index === undefined) return null;
  return {
    status: Number(block[1]),
    body: raw.slice(block.index + block[0].length).trim(),
    retryAfterAt: retryAfterAtFromMessage(block[2] ?? ""),
  };
}

function errorMessageFromResponse(body: unknown): string | null {
  if (!isRecord(body) || !("errors" in body)) return null;
  const errors = body.errors;
  if (errors === null) return null;
  if (!Array.isArray(errors)) return "GitHub returned an invalid GraphQL error response.";
  const messages = errors
    .map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : null))
    .filter((message): message is string => message !== null)
    .join("; ");
  return messages.length > 0 ? messages : null;
}

function apiErrorMessageFromResponse(body: unknown): string | null {
  return isRecord(body) && typeof body.message === "string" ? body.message : null;
}

function mapPullRequestSummary(
  pullRequest: Record<string, unknown>,
): Effect.Effect<GitHubPullRequestSummary, GitHubCliError> {
  const raw = {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    state: pullRequest.state,
    mergedAt: pullRequest.mergedAt,
    isCrossRepository: pullRequest.isCrossRepository,
    headRepository: pullRequest.headRepository,
    headRepositoryOwner: pullRequest.headRepositoryOwner,
  };
  return Effect.sync(() => decodeGitHubPullRequestJson(JSON.stringify(raw))).pipe(
    Effect.flatMap((decoded) =>
      Result.isSuccess(decoded)
        ? Effect.succeed((({ updatedAt: _updatedAt, ...summary }) => summary)(decoded.success))
        : Effect.fail(
            new GitHubCliError({
              operation: "getPullRequest",
              detail: `GitHub API returned invalid PR JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
              cause: decoded.failure,
            }),
          ),
    ),
  );
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "listOpenPullRequests" | "getPullRequest" | "getRepositoryCloneUrls",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.gen(function* () {
      // No extra quota is spent to observe usage: `GH_DEBUG=api` makes `gh`
      // itself report each HTTP request and the response rate-limit headers
      // on stderr. Tokens arrive redacted (`token ████`) and debug lines are
      // stripped from failure details before they reach any caller.
      const startedAt = Date.now();
      const attempt = yield* Effect.tryPromise({
        try: () =>
          runProcess("gh", input.args, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            env: { ...process.env, GH_DEBUG: "api" },
            ...(input.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            ...(input.maxOutputBytes === undefined
              ? {}
              : {
                  maxBufferBytes: input.maxOutputBytes,
                  outputMode: input.truncateOutputAtMaxBytes === true ? "truncate" : "error",
                }),
          }),
        catch: (error: unknown) => error,
      }).pipe(
        Effect.map((result) => ({ status: "ok" as const, result })),
        Effect.catch((raw: unknown) => Effect.succeed({ status: "failed" as const, raw })),
      );
      const latencyMs = Date.now() - startedAt;
      const usage = yield* Effect.serviceOption(GitHubApiUsage);
      const attribution = {
        operation: summarizeGhArgs(input.args),
        feature: input.usage?.feature ?? "unknown",
        host: input.usage?.host ?? "unknown",
        ...(input.usage?.repository == null ? {} : { repository: input.usage.repository }),
        ...(input.usage?.prNumber == null ? {} : { prNumber: input.usage.prNumber }),
      };

      if (attempt.status === "ok") {
        const result = attempt.result;
        // Resolution is not success: `allowNonZeroExit` callers resolve on
        // HTTP errors and interpret the response themselves.
        const outcome = classifyResolvedOutcome({
          code: result.code,
          timedOut: result.timedOut,
          stderr: result.stderr,
          stdout: result.stdout,
        });
        if (usage._tag === "Some") {
          const telemetry = parseGhDebugTelemetry(result.stderr);
          const cooldown = outcome === "success" ? null : parseGhCooldown(result.stderr);
          yield* usage.value.record({
            ...attribution,
            httpRequests: telemetry.httpRequestCount,
            outcome,
            latencyMs,
            rateLimits: telemetry.rateLimits,
            ...(cooldown?.retryAfterAtMs !== null && cooldown?.retryAfterAtMs !== undefined
              ? { retryAfterAtMs: cooldown.retryAfterAtMs }
              : {}),
            ...(cooldown?.secondary === true ? { secondaryRateLimit: true } : {}),
          });
        }
        return result;
      }

      const raw = attempt.raw;
      const failure =
        raw instanceof Error ? raw : new Error("GitHub CLI command failed with no detail.");
      // The runner embeds stderr in the failure message behind an
      // `<argv> <reason>.` prefix; recover the raw stderr first so the
      // first request's trace line and rate-limit headers parse exactly.
      const { stderr } = splitRunnerMessage(failure.message, input.args);
      const telemetry = parseGhDebugTelemetry(stderr);
      const normalized = normalizeGitHubCliError("execute", failure, input.args);
      if (usage._tag === "Some") {
        const outcome = isGitHubRateLimitMessage(normalized.detail) ? "rate-limited" : "failure";
        const cooldown = parseGhCooldown(stderr);
        yield* usage.value.record({
          ...attribution,
          httpRequests: telemetry.httpRequestCount,
          outcome,
          latencyMs,
          rateLimits: telemetry.rateLimits,
          ...(cooldown.retryAfterAtMs !== null ? { retryAfterAtMs: cooldown.retryAfterAtMs } : {}),
          ...(cooldown.secondary ? { secondaryRateLimit: true } : {}),
        });
      }
      return yield* normalized;
    });

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "association" },
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(
                        decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                      )
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listOpenPullRequests",
                          detail: `GitHub CLI returned invalid PR list JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    listRepositoryOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "association" },
        args: [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 100),
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(
                        decoded.success.map(({ updatedAt: _updatedAt, ...summary }) => summary),
                      )
                    : Effect.fail(
                        new GitHubCliError({
                          operation: "listOpenPullRequests",
                          detail: `GitHub CLI returned invalid PR list JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    getPullRequest: (input) =>
      Effect.gen(function* () {
        const reference = explicitPullRequestUrl(input.reference);
        if (!reference) {
          const repositoryArgs =
            input.repository !== undefined && input.repository.trim().length > 0
              ? ["--repo", input.repository.trim()]
              : [];
          const result = yield* execute({
            cwd: input.cwd,
            usage: { feature: "association" },
            args: [
              "pr",
              "view",
              input.reference,
              ...repositoryArgs,
              "--json",
              "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
            ],
          });
          const decoded = decodeGitHubPullRequestJson(result.stdout.trim());
          if (Result.isSuccess(decoded)) {
            const { updatedAt: _updatedAt, ...summary } = decoded.success;
            return summary;
          }
          return yield* new GitHubCliError({
            operation: "getPullRequest",
            detail: `GitHub CLI returned invalid PR JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
            cause: decoded.failure,
          });
        }

        const result = yield* execute({
          cwd: input.cwd,
          allowNonZeroExit: true,
          usage: { feature: "association", host: reference.hostname },
          args: [
            "api",
            "--hostname",
            reference.hostname,
            "--include",
            "graphql",
            "-f",
            `query=${PULL_REQUEST_BY_URL_QUERY}`,
            "-f",
            `owner=${reference.owner}`,
            "-f",
            `name=${reference.repository}`,
            "-F",
            `number=${reference.number}`,
          ],
        });
        const response = parseIncludedApiResponse(result.stdout);
        if (!response) {
          return yield* normalizeGitHubCliError(
            "execute",
            new Error(result.stderr || "GitHub CLI did not return an HTTP response."),
          );
        }

        const body = yield* Effect.try({
          try: () => JSON.parse(response.body) as unknown,
          catch: (cause) =>
            new GitHubCliError({
              operation: "getPullRequest",
              detail: "GitHub API returned invalid response JSON.",
              cause,
            }),
        });

        const graphQlError = errorMessageFromResponse(body);
        if (response.status < 200 || response.status >= 300 || graphQlError !== null) {
          const detail =
            graphQlError ||
            apiErrorMessageFromResponse(body) ||
            `GitHub API request failed with HTTP ${response.status}.`;
          const rateLimited =
            response.status === 429 || /rate[\s-]?limit|secondary rate/iu.test(detail);
          return yield* new GitHubCliError({
            operation: "getPullRequest",
            detail: `GitHub API failed to resolve pull request: ${detail}`,
            ...(rateLimited && response.retryAfterAt
              ? { retryAfterAt: response.retryAfterAt }
              : {}),
          });
        }

        const data = isRecord(body) && isRecord(body.data) ? body.data : null;
        const repository = data && isRecord(data.repository) ? data.repository : null;
        const resolved =
          repository && isRecord(repository.pullRequest) ? repository.pullRequest : null;
        if (!resolved) {
          return yield* new GitHubCliError({
            operation: "getPullRequest",
            detail: "Pull request not found. Check the PR number or URL and try again.",
          });
        }
        return yield* mapPullRequestSummary(resolved);
      }),
    getPullRequestPatch: (input) => {
      const repositoryArgs =
        input.repository !== undefined && input.repository.trim().length > 0
          ? ["--repo", input.repository.trim()]
          : [];
      return execute({
        cwd: input.cwd,
        usage: { feature: "diff" },
        args: ["pr", "diff", input.reference, ...repositoryArgs],
      }).pipe(Effect.map((result) => result.stdout));
    },
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "repository" },
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "create" },
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
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "repository" },
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        usage: { feature: "checkout" },
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
