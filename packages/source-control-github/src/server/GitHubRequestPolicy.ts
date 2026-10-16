import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";

const DEFAULT_TIMEOUT = Duration.seconds(30);
/** Polite to GitHub's secondary limits, which punish bursts of concurrent requests. */
const CONCURRENCY = 8;
/** The headers every GitHub request carries besides its token. */
const REQUEST_HEADERS = { "x-github-api-version": "2022-11-28", "user-agent": "t3code" };

/**
 * A credential already verified for one host. Every request made under it must target that
 * host, so a page cannot read one account's data with another's token mid-flight. Server-local:
 * never put its value in RPC payloads or cache keys.
 */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("@t3tools/source-control-github/server/GitHubRequestPolicy/PinnedGitHubCredential", {
  defaultValue: () => null,
});

export class GitHubApiRequestError extends Schema.TaggedError<GitHubApiRequestError>()(
  "GitHubApiRequestError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not reach GitHub at ${this.host}.`;
  }
}

export class GitHubApiAuthenticationError extends Schema.TaggedError<GitHubApiAuthenticationError>()(
  "GitHubApiAuthenticationError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return `GitHub refused the credential for ${this.host}. Run \`gh auth login --hostname ${this.host}\` and retry.`;
  }
}

export class GitHubApiRateLimitError extends Schema.TaggedError<GitHubApiRateLimitError>()(
  "GitHubApiRateLimitError",
  {
    host: Schema.String,
    operation: Schema.String,
    retryAt: Schema.optionalKey(Schema.Finite),
  },
) {
  override get message(): string {
    return "GitHub API rate limit exceeded.";
  }
}

export class GitHubApiNotFoundError extends Schema.TaggedError<GitHubApiNotFoundError>()(
  "GitHubApiNotFoundError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return "GitHub could not find the requested resource, or the credential cannot see it.";
  }
}

/**
 * GitHub answered with a failure that is none of the above. `githubErrors` carries GitHub's own
 * error messages, from a GraphQL `errors` list or a REST `message`/`errors` body: they name the
 * field and the reason ("A pull request already exists for acme:feature"), never a token.
 */
export class GitHubApiResponseError extends Schema.TaggedError<GitHubApiResponseError>()(
  "GitHubApiResponseError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.Int,
    githubErrors: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    return this.githubErrors !== undefined && this.githubErrors.length > 0
      ? `GitHub returned an error: ${this.githubErrors.join("; ")}`
      : `GitHub returned HTTP ${this.status}.`;
  }
}

export type GitHubApiError =
  | GitHubCredentials.GitHubCredentialUnavailableError
  | GitHubApiRequestError
  | GitHubApiAuthenticationError
  | GitHubApiRateLimitError
  | GitHubApiNotFoundError
  | GitHubApiResponseError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Where the API for a host lives. github.com and GHE.com data residency serve it from an `api.`
 * subdomain; GitHub Enterprise Server serves it under `/api` on the instance itself.
 */
export function gitHubApiUrls(host: string): { readonly rest: string; readonly graphql: string } {
  const normalized = normalizeHost(host);
  if (normalized === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (normalized.endsWith(".ghe.com")) {
    return {
      rest: `https://api.${normalized}`,
      graphql: `https://api.${normalized}/graphql`,
    };
  }
  return { rest: `https://${normalized}/api/v3`, graphql: `https://${normalized}/api/graphql` };
}

/** The numeric rate-limit headers GitHub sends, as span attributes. */
function rateLimitAttributes(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, number | string> {
  const attributes: Record<string, number | string> = {};
  for (const [header, name] of [
    ["x-ratelimit-limit", "github.ratelimit.limit"],
    ["x-ratelimit-remaining", "github.ratelimit.remaining"],
    ["x-ratelimit-used", "github.ratelimit.used"],
    ["x-ratelimit-reset", "github.ratelimit.reset"],
  ] as const) {
    const value = Number(headers[header]);
    if (headers[header] !== undefined && Number.isFinite(value)) attributes[name] = value;
  }
  const resource = headers["x-ratelimit-resource"];
  if (resource !== undefined) attributes["github.ratelimit.resource"] = resource;
  return attributes;
}

/** The pause GitHub asked for, from `retry-after` or the primary limit's reset. */
function retryAtFrom(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number | undefined {
  const fromRetryAfter = SourceControlRateLimit.retryAtFromHeader(headers["retry-after"], now);
  if (fromRetryAfter !== undefined) return fromRetryAfter;
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}

/**
 * Whether GitHub refused a request for its rate limit. A GraphQL answer can say so with HTTP 200:
 * a `RATE_LIMITED` error, or an exhausted quota that answers an untyped "API rate limit already
 * exceeded" error, which the headers confirm.
 */
export function isRateLimited(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The GraphQL `errors` list, when the answer is a GraphQL one and has any. */
  readonly graphqlErrors?: ReadonlyArray<{ readonly type?: unknown; readonly message?: unknown }>;
  readonly body?: string;
}): boolean {
  const { status, headers, graphqlErrors: errors } = input;
  return (
    status === 429 ||
    (errors !== undefined &&
      (headers["x-ratelimit-remaining"] === "0" ||
        errors.some(
          (error) =>
            error.type === "RATE_LIMITED" ||
            (typeof error.message === "string" &&
              /rate limit (already )?exceeded/i.test(error.message)),
        ))) ||
    (status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        headers["retry-after"] !== undefined ||
        /rate limit/i.test(input.body ?? "")))
  );
}

/**
 * What one GitHub answer means, as the transport that read it decided: `Ok` carries what the
 * request returns; every other verdict fails with the `GitHubApi*Error` that says why.
 */
export type GitHubAnswer<A> = {
  /** Unset when the transport reported none. */
  readonly status: number | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
} & (
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "RateLimited" | "Unauthorized" | "NotFound" }
  | { readonly _tag: "Failed"; readonly messages?: ReadonlyArray<string> | undefined }
);

export interface GitHubRequest {
  readonly host: string;
  readonly operation: string;
  /** The quota the request spends: `core` for REST, `graphql` for GraphQL. */
  readonly resource: string;
  readonly allowReserve: boolean;
  /** Covers sending and reading the answer. Defaults to 30 seconds. */
  readonly timeout?: Duration.Input | undefined;
}

/**
 * What every GitHub request goes through, REST and GraphQL alike: the host's credential, one
 * shared pool of request slots, the quota reserve and the host-wide pause before it is sent, and
 * what GitHub's answer says about them after. Each transport only sends and reads its answer.
 */
export class GitHubRequestPolicy extends Context.Service<
  GitHubRequestPolicy,
  {
    /**
     * Sends one request. `send` receives the headers it must carry (the token and GitHub's API
     * version) and reports the answer; a failure of its own passes through untouched.
     */
    readonly request: <A, E, R>(
      input: GitHubRequest,
      send: (headers: Readonly<Record<string, string>>) => Effect.Effect<GitHubAnswer<A>, E, R>,
    ) => Effect.Effect<A, E | GitHubApiError, R>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("@t3tools/source-control-github/server/GitHubRequestPolicy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const quota = yield* GitHubQuota.GitHubQuota;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const slots = yield* Semaphore.make(CONCURRENCY);

  const credential: GitHubRequestPolicy["Service"]["credential"] = Effect.fn(
    "GitHubRest.credential",
  )(function* (host) {
    const normalized = normalizeHost(host);
    const pinned = yield* PinnedGitHubCredential;
    if (pinned !== null) {
      // A pinned page only ever talks to the host it verified.
      if (pinned.host !== normalized) {
        return yield* new GitHubApiAuthenticationError({
          host: normalized,
          operation: "credential",
        });
      }
      return { token: pinned.token, fingerprint: pinned.credentialFingerprint };
    }
    const held = yield* credentials.get(normalized);
    return { token: held.token, fingerprint: held.fingerprint };
  });

  const request: GitHubRequestPolicy["Service"]["request"] = <A, E, R>(
    input: GitHubRequest,
    send: (headers: Readonly<Record<string, string>>) => Effect.Effect<GitHubAnswer<A>, E, R>,
  ) =>
    Effect.gen(function* () {
      const host = normalizeHost(input.host);
      const context = { host, operation: input.operation };
      yield* Effect.annotateCurrentSpan({
        "github.host": host,
        "github.operation": input.operation,
      });
      const { token, fingerprint } = yield* credential(host);
      const scope = yield* SourceControlRateLimit.CredentialScope;
      // A refusal pauses the whole host, whichever quota it spent: the key PullRequestService
      // records its own backoff under.
      const key = { provider: SourceControlProviderKind.make("github"), host };

      const settle = (lease: number, answer: GitHubAnswer<A>) =>
        Effect.gen(function* () {
          yield* quota.observe(host, answer.headers);
          yield* Effect.annotateCurrentSpan({
            ...(answer.status === undefined ? {} : { "http.response.status_code": answer.status }),
            ...rateLimitAttributes(answer.headers),
          });
          switch (answer._tag) {
            case "Ok":
              yield* limits.recordSuccess({ ...key, lease });
              return answer.value;
            case "RateLimited": {
              const retryAt = retryAtFrom(answer.headers, yield* Clock.currentTimeMillis);
              yield* limits.recordRateLimit({ ...key, lease, retryAt });
              yield* Effect.annotateCurrentSpan({
                "github.rate_limited": true,
                ...(retryAt === undefined ? {} : { "github.retry_at": retryAt }),
              });
              return yield* new GitHubApiRateLimitError({
                ...context,
                ...(retryAt === undefined ? {} : { retryAt }),
              });
            }
            case "Unauthorized":
              // The source may hold a newer token than the one that was refused.
              yield* credentials.invalidate(host);
              return yield* new GitHubApiAuthenticationError(context);
            case "NotFound":
              return yield* new GitHubApiNotFoundError(context);
            case "Failed":
              return yield* new GitHubApiResponseError({
                ...context,
                status: answer.status ?? 200,
                ...(answer.messages === undefined ? {} : { githubErrors: answer.messages }),
              });
          }
        });

      const run = Effect.gen(function* () {
        const lease = yield* quota
          .admit(host, input.resource, { allowReserve: input.allowReserve })
          .pipe(
            Effect.andThen(
              limits.check(key, input.allowReserve ? { allowPaused: true } : undefined),
            ),
            Effect.tapError((paused) =>
              Effect.annotateCurrentSpan({
                "github.paused": true,
                "github.retry_at": paused.retryAt,
              }),
            ),
          );
        // One deadline covers the headers and the body: a host that answers headers and then
        // stalls must not hold a shared slot for undici's own five-minute body timeout.
        const answer = yield* send({
          ...REQUEST_HEADERS,
          authorization: `Bearer ${Redacted.value(token)}`,
        }).pipe(
          Effect.timeoutOrElse({
            duration: input.timeout ?? DEFAULT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new GitHubApiRequestError({ ...context, cause: new Cause.TimeoutError() }),
              ),
          }),
        );
        return yield* settle(lease, answer);
      });
      // The rate-limit scope follows the credential, so a pause on one account never blocks another.
      return yield* slots
        .withPermit(run)
        .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope || fingerprint));
    });

  return GitHubRequestPolicy.of({ request, credential });
});

export const layer = Layer.effect(GitHubRequestPolicy, make);
