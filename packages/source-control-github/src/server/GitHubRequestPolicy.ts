import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";

export const gitHubRequestsTotal = Metric.counter("t3_github_requests_total", {
  description: "Actual GitHub HTTP requests by quota resource and response status",
});

const DEFAULT_TIMEOUT = Duration.seconds(30);
const MINIMUM_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** GitHub's secondary limits penalize concurrent bursts. */
const CONCURRENCY = 8;
const REQUEST_HEADERS = { "x-github-api-version": "2022-11-28", "user-agent": "t3code" };

/** Pin requests to this host's credential across account switches. Keep it out of RPCs/cache keys. */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
  readonly source?: GitHubCredentials.GitHubCredentialSource;
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
    resource: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "GitHub API rate limit exceeded.";
  }
}

export class GitHubApiNotFoundError extends Schema.TaggedError<GitHubApiNotFoundError>()(
  "GitHubApiNotFoundError",
  {
    host: Schema.String,
    operation: Schema.String,
    /** The source of the credential the refused request carried, when known. */
    credential: Schema.optionalKey(GitHubCredentials.GitHubCredentialSource),
  },
) {
  override get message(): string {
    return "GitHub could not find the requested resource, or the credential cannot see it.";
  }
}

export class GitHubApiResponseError extends Schema.TaggedError<GitHubApiResponseError>()(
  "GitHubApiResponseError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.Int,
    githubErrors: Schema.optionalKey(Schema.Array(Schema.String)),
    githubErrorTypes: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
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
  | GitHubAppSignIn.GitHubAppSessionError
  | GitHubApiRequestError
  | GitHubApiAuthenticationError
  | GitHubApiRateLimitError
  | GitHubApiNotFoundError
  | GitHubApiResponseError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

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

function retryAtFrom(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number | undefined {
  const fromRetryAfter = SourceControlRateLimit.retryAtFromHeader(headers["retry-after"], now);
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  if (headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset) && reset > now) {
    return Math.max(reset, fromRetryAfter ?? 0);
  }
  return fromRetryAfter;
}

interface RateLimitResponse {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly graphqlErrors?: ReadonlyArray<{ readonly type?: unknown; readonly message?: unknown }>;
  readonly body?: string;
}

export function isSecondaryRateLimited(input: RateLimitResponse): boolean {
  return (
    input.headers["retry-after"] !== undefined ||
    /secondary rate limit/i.test(input.body ?? "") ||
    (input.graphqlErrors ?? []).some(
      (error) => typeof error.message === "string" && /secondary rate limit/i.test(error.message),
    )
  );
}

/** HTTP 200 GraphQL rate limits use RATE_LIMITED or untyped errors with quota headers. */
export function isRateLimited(input: RateLimitResponse & { readonly status: number }): boolean {
  const { status, headers, graphqlErrors: errors } = input;
  return (
    status === 429 ||
    (errors !== undefined &&
      errors.length > 0 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        isSecondaryRateLimited(input) ||
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

export type GitHubAnswer<A> = {
  readonly status: number | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
} & (
  | {
      readonly _tag: "Ok";
      readonly value: A;
      /** GitHub left part of the answer out as not found or forbidden for this credential. */
      readonly withheld?: boolean;
    }
  | { readonly _tag: "RateLimited"; readonly secondary?: boolean }
  | { readonly _tag: "Unauthorized" | "NotFound" }
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

/** REST/GraphQL share credentials, slots and secondary pauses; primary quotas stay separate. */
export class GitHubRequestPolicy extends Context.Service<
  GitHubRequestPolicy,
  {
    /**
     * send receives auth/version headers and the source of the credential they carry; its
     * failures pass through unchanged.
     */
    readonly request: <A, E, R>(
      input: GitHubRequest,
      send: (
        headers: Readonly<Record<string, string>>,
        source: GitHubCredentials.GitHubCredentialSource | undefined,
      ) => Effect.Effect<GitHubAnswer<A>, E, R>,
    ) => Effect.Effect<A, E | GitHubApiError, R>;
    /**
     * The credential requests to `host` use: a token saved in Settings, else the app sign-in,
     * else `GH_TOKEN` or `gh`. `personal` skips the app, for repositories it cannot reach.
     */
    readonly credential: (
      host: string,
      options?: { readonly personal?: boolean },
    ) => Effect.Effect<GitHubHeldCredential, GitHubApiError>;
    /** The app sign-in's own credential, whatever else outranks it; none when not signed in. */
    readonly appCredential: (
      host: string,
    ) => Effect.Effect<Option.Option<GitHubHeldCredential>, GitHubAppSignIn.GitHubAppSessionError>;
  }
>()("@t3tools/source-control-github/server/GitHubRequestPolicy") {}

export interface GitHubHeldCredential {
  readonly source?: GitHubCredentials.GitHubCredentialSource;
  readonly token: Redacted.Redacted<string>;
  readonly fingerprint: string;
}

interface ChosenCredential extends GitHubHeldCredential {
  readonly fromApp: boolean;
}

/**
 * The app reaches only repositories where it is installed. A not-found or "not accessible by
 * integration" answer to its token is worth one more try with the user's own credential.
 */
function refusedToApp<A>(answer: GitHubAnswer<A>): boolean {
  switch (answer._tag) {
    case "NotFound":
      return true;
    case "Ok":
      return answer.withheld === true;
    case "Failed":
      return (
        answer.status === 403 &&
        (answer.messages ?? []).some((message) => /not accessible by integration/i.test(message))
      );
    default:
      return false;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const quota = yield* GitHubQuota.GitHubQuota;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const slots = yield* Semaphore.make(CONCURRENCY);

  const personalCredential = (host: string) =>
    credentials.get(host).pipe(
      Effect.map((held): ChosenCredential => ({
        token: held.token,
        fingerprint: held.fingerprint,
        source: held.source,
        fromApp: false,
      })),
    );

  const appCredential: GitHubRequestPolicy["Service"]["appCredential"] = Effect.fn(
    "GitHubRest.appCredential",
  )(function* (host) {
    const token = yield* appSignIn.token(normalizeHost(host));
    if (Option.isNone(token)) return Option.none();
    return Option.some({
      source: "app" as const,
      token: Redacted.make(token.value),
      fingerprint: yield* credentials.fingerprint(normalizeHost(host), token.value),
    });
  });

  const choose = Effect.fn("GitHubRest.credential")(function* (host: string, personal: boolean) {
    const pinned = yield* PinnedGitHubCredential;
    if (pinned !== null) {
      if (pinned.host !== host) {
        return yield* new GitHubApiAuthenticationError({ host, operation: "credential" });
      }
      return {
        token: pinned.token,
        fingerprint: pinned.credentialFingerprint,
        ...(pinned.source === undefined ? {} : { source: pinned.source }),
        fromApp: false,
      } satisfies ChosenCredential;
    }
    const saved = yield* credentials.saved(host);
    if (Option.isSome(saved)) {
      return {
        token: saved.value.token,
        fingerprint: saved.value.fingerprint,
        source: saved.value.source,
        fromApp: false,
      };
    }
    if (personal) return yield* personalCredential(host);
    const app = yield* Effect.result(appCredential(host));
    // An app session that cannot refresh right now steps aside for the user's own credential.
    if (Result.isFailure(app)) {
      return yield* personalCredential(host).pipe(Effect.mapError(() => app.failure));
    }
    if (Option.isNone(app.success)) return yield* personalCredential(host);
    return { ...app.success.value, fromApp: true } satisfies ChosenCredential;
  });

  const credential: GitHubRequestPolicy["Service"]["credential"] = (host, options) =>
    choose(normalizeHost(host), options?.personal === true).pipe(
      Effect.map(({ token, fingerprint, source }) => ({
        token,
        fingerprint,
        ...(source === undefined ? {} : { source }),
      })),
    );

  // The REST/GraphQL transport span owns request and quota metadata.
  const request: GitHubRequestPolicy["Service"]["request"] = Effect.fnUntraced(function* <A, E, R>(
    input: GitHubRequest,
    send: (
      headers: Readonly<Record<string, string>>,
      source: GitHubCredentials.GitHubCredentialSource | undefined,
    ) => Effect.Effect<GitHubAnswer<A>, E, R>,
  ) {
    const host = normalizeHost(input.host);
    const context = { host, operation: input.operation };
    yield* Effect.annotateCurrentSpan({
      "github.host": host,
      "github.operation": input.operation,
    });
    const scope = yield* SourceControlRateLimit.CredentialScope;
    const key = { provider: SourceControlProviderKind.make("github"), host };
    const resourceKey = { ...key, resource: input.resource };

    // Settlement annotates the request span with status and rate-limit attributes.
    const settle = Effect.fnUntraced(function* (
      leases: { readonly host: number; readonly resource: number },
      answer: GitHubAnswer<A>,
      held: ChosenCredential,
    ) {
      yield* quota.observe(host, answer.headers);
      yield* Effect.annotateCurrentSpan({
        ...(answer.status === undefined ? {} : { "http.response.status_code": answer.status }),
        ...rateLimitAttributes(answer.headers),
      });
      switch (answer._tag) {
        case "Ok":
          yield* limits.recordSuccess({ ...key, lease: leases.host });
          yield* limits.recordSuccess({ ...resourceKey, lease: leases.resource });
          return answer.value;
        case "RateLimited": {
          const now = yield* Clock.currentTimeMillis;
          const primary = answer.headers["x-ratelimit-remaining"] === "0";
          const secondary =
            !primary || answer.secondary === true || answer.headers["retry-after"] !== undefined;
          const proposedRetryAt = retryAtFrom(answer.headers, now);
          if (primary) {
            yield* limits.recordRateLimit({
              ...resourceKey,
              lease: leases.resource,
              retryAt: proposedRetryAt,
              minimumCooldownMs: MINIMUM_RATE_LIMIT_COOLDOWN_MS,
            });
          }
          if (secondary) {
            yield* limits.recordRateLimit({
              ...key,
              lease: leases.host,
              retryAt: SourceControlRateLimit.retryAtFromHeader(answer.headers["retry-after"], now),
              minimumCooldownMs: MINIMUM_RATE_LIMIT_COOLDOWN_MS,
            });
          }
          const retryAt = yield* limits.check(secondary ? key : resourceKey).pipe(
            Effect.match({
              onFailure: (paused) => paused.retryAt,
              onSuccess: () => proposedRetryAt ?? now + MINIMUM_RATE_LIMIT_COOLDOWN_MS,
            }),
          );
          yield* Effect.annotateCurrentSpan({
            "github.rate_limited": true,
            "github.retry_at": retryAt,
          });
          return yield* new GitHubApiRateLimitError({
            ...context,
            retryAt,
            ...(secondary ? {} : { resource: input.resource }),
          });
        }
        case "Unauthorized":
          // The source may hold a newer token than the one that was refused.
          yield* appSignIn.invalidate(host, Redacted.value(held.token));
          yield* credentials.invalidate(host);
          return yield* new GitHubApiAuthenticationError(context);
        case "NotFound":
          return yield* new GitHubApiNotFoundError({
            ...context,
            ...(held.source === undefined ? {} : { credential: held.source }),
          });
        case "Failed":
          return yield* new GitHubApiResponseError({
            ...context,
            status: answer.status ?? 200,
            ...(answer.messages === undefined ? {} : { githubErrors: answer.messages }),
          });
      }
    });

    /** One send under `held`; `Retry` hands an app-refused request to the user's credential. */
    const attempt = (held: ChosenCredential) =>
      slots
        .withPermit(
          Effect.gen(function* () {
            const leases = yield* Effect.all({
              host: limits.check(key),
              resource: limits.check(resourceKey),
            }).pipe(
              Effect.tap(() =>
                quota.admit(host, input.resource, { allowReserve: input.allowReserve }),
              ),
              Effect.tapError((paused) =>
                Effect.annotateCurrentSpan({
                  "github.paused": true,
                  "github.retry_at": paused.retryAt,
                  "github.pause_reason": paused.pauseReason ?? "rate-limited",
                }),
              ),
            );
            // One deadline covers the headers and the body: a host that answers headers and then
            // stalls must not hold a shared slot for undici's own five-minute body timeout.
            const answer = yield* send(
              { ...REQUEST_HEADERS, authorization: `Bearer ${Redacted.value(held.token)}` },
              held.source,
            ).pipe(
              Effect.timeoutOrElse({
                duration: input.timeout ?? DEFAULT_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new GitHubApiRequestError({ ...context, cause: new Cause.TimeoutError() }),
                  ),
              }),
              Effect.tapError(() =>
                Metric.update(
                  Metric.withAttributes(gitHubRequestsTotal, {
                    resource: input.resource,
                    status: "0",
                  }),
                  1,
                ),
              ),
            );
            yield* Metric.update(
              Metric.withAttributes(gitHubRequestsTotal, {
                resource: input.resource,
                status: String(answer.status ?? 0),
              }),
              1,
            );
            if (held.fromApp && refusedToApp(answer)) {
              const personal = yield* Effect.option(personalCredential(host));
              if (Option.isSome(personal)) {
                yield* quota.observe(host, answer.headers);
                yield* limits.recordSuccess({ ...key, lease: leases.host });
                yield* limits.recordSuccess({ ...resourceKey, lease: leases.resource });
                yield* Effect.annotateCurrentSpan({ "github.app_refused": true });
                return { _tag: "Retry", with: personal.value } as const;
              }
            }
            return { _tag: "Done", value: yield* settle(leases, answer, held) } as const;
          }),
        )
        // The rate-limit scope follows the credential, so a pause on one account never blocks another.
        .pipe(
          Effect.provideService(SourceControlRateLimit.CredentialScope, scope || held.fingerprint),
        );

    // Only an app credential is handed on, so this runs at most twice.
    let held = yield* choose(host, false);
    while (true) {
      const outcome = yield* attempt(held);
      if (outcome._tag === "Done") return outcome.value;
      held = outcome.with;
    }
  });

  return GitHubRequestPolicy.of({ request, credential, appCredential });
});

export const layer = Layer.effect(GitHubRequestPolicy, make);
