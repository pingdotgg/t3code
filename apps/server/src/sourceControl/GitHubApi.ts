import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const DEFAULT_TIMEOUT = Duration.seconds(30);
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Polite to GitHub's secondary limits, which punish bursts of concurrent requests. */
const CONCURRENCY = 8;
const API_VERSION = "2022-11-28";

/**
 * A credential already verified for one host. Every request made under it must target that
 * host, so a page cannot read one account's data with another's token mid-flight. Server-local:
 * never put its value in RPC payloads or cache keys.
 */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("t3/sourceControl/PinnedGitHubCredential", { defaultValue: () => null });

/**
 * Set by interactive callers (a user's read or write, not a background sweep). Requests made
 * under it may spend the GraphQL reserve and go through a rate-limit pause: a user acting on a
 * pull request should not be refused because a background read exhausted the quota.
 */
export const AllowGitHubReserve = Context.Reference<boolean>(
  "t3/sourceControl/AllowGitHubReserve",
  { defaultValue: () => false },
);

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

export interface GitHubRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  /** The body was not valid UTF-8, which a raw file read takes to mean binary. */
  readonly invalidUtf8: boolean;
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, e.g. `repos/acme/web/pulls/7`; query string included. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidates a cached answer. A 304 is returned rather than failed, and is free. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Defaults to 30 seconds; a whole pull request's patch may need longer. */
  readonly timeout?: Duration.Input;
  /** Overrides `AllowGitHubReserve` for this one request. */
  readonly allowReserve?: boolean;
}

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly allowReserve?: boolean;
  readonly maxResponseBytes?: number;
}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer, with `rateLimit` recorded. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("t3/sourceControl/GitHubApi") {}

function normalizeHost(host: string): string {
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

/** GraphQL documents longer than this are cut in traces; the hash still identifies them. */
const TRACED_QUERY_MAX_CHARS = 4_000;

/** A stable short id for a GraphQL document, so traces group by query without its text. */
function queryHash(query: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < query.length; index++) {
    hash ^= query.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

const decodeGraphQlCost = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        rateLimit: Schema.Struct({ cost: Schema.Number, remaining: Schema.Number }),
      }),
    }),
  ),
);

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

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** A REST failure body: `{ message, errors: [{ message } | { resource, field, code }] }`. */
const decodeRestErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Struct({
              message: Schema.optional(Schema.String),
              field: Schema.optional(Schema.String),
              code: Schema.optional(Schema.String),
            }),
          ]),
        ),
      ),
    }),
  ),
);

function restErrorMessages(body: string): ReadonlyArray<string> | undefined {
  return Option.match(decodeRestErrors(body), {
    onNone: () => undefined,
    onSome: (decoded) => {
      const details = (decoded.errors ?? []).flatMap((error) =>
        typeof error === "string"
          ? [error]
          : error.message !== undefined
            ? [error.message]
            : error.field !== undefined && error.code !== undefined
              ? [`${error.field} ${error.code}`]
              : [],
      );
      const messages = [...(decoded.message === undefined ? [] : [decoded.message]), ...details];
      return messages.length > 0 ? messages : undefined;
    },
  });
}

/** What one GitHub answer means, decided once from its status, headers and body. */
type Answer = Data.TaggedEnum<{
  Ok: {};
  RateLimited: {};
  Unauthorized: {};
  NotFound: {};
  Failed: { readonly messages: ReadonlyArray<string> | undefined };
}>;
const Answer = Data.taggedEnum<Answer>();

/**
 * GitHub reports a failed GraphQL document with HTTP 200 and an `errors` list, so a GraphQL body
 * is read for its error types as well as its status. `gh api graphql` failed those too, and
 * callers rely on that to fall back to narrower reads.
 */
function classify(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly graphql: boolean;
  readonly acceptNotModified: boolean;
}): Answer {
  const { status, headers, body } = input;
  const errors = input.graphql
    ? Option.getOrUndefined(decodeGraphQlErrors(body))?.errors
    : undefined;
  const types = errors?.flatMap((error) => (error.type === undefined ? [] : [error.type])) ?? [];
  const messages = errors?.flatMap((error) => (error.message === undefined ? [] : [error.message]));
  if (
    status === 429 ||
    types.includes("RATE_LIMITED") ||
    // An exhausted GraphQL quota can answer HTTP 200 with an untyped "API rate limit already
    // exceeded" error; the headers say the same thing.
    (input.graphql && errors !== undefined && headers["x-ratelimit-remaining"] === "0") ||
    (input.graphql &&
      messages !== undefined &&
      messages.some((message) => /rate limit (already )?exceeded/i.test(message))) ||
    (status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        headers["retry-after"] !== undefined ||
        /rate limit/i.test(body)))
  ) {
    return Answer.RateLimited();
  }
  if (status === 401) return Answer.Unauthorized();
  if (
    status === 404 ||
    (errors !== undefined && errors.every((error) => error.type === "NOT_FOUND"))
  ) {
    return Answer.NotFound();
  }
  if (errors !== undefined) return Answer.Failed({ messages });
  if ((status >= 200 && status < 300) || (status === 304 && input.acceptNotModified)) {
    return Answer.Ok();
  }
  return Answer.Failed({ messages: input.graphql ? undefined : restErrorMessages(body) });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const gate = yield* Semaphore.make(CONCURRENCY);

  const credential: GitHubApi["Service"]["credential"] = Effect.fn("GitHubApi.credential")(
    function* (host) {
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
    },
  );

  /**
   * Sends one request under the host's rate-limit pause and fails a refusal with the error that
   * says why. `onSuccess` sees the answer only once it is known to be one.
   */
  const send = Effect.fn("GitHubApi.send")(function* (input: {
    readonly host: string;
    readonly operation: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly maxResponseBytes: number;
    readonly timeout?: Duration.Input | undefined;
    readonly allowReserve: boolean;
    readonly acceptNotModified: boolean;
    /** Reads the body for GraphQL `errors`, which GitHub sends with HTTP 200. */
    readonly graphql?: boolean;
  }) {
    const host = normalizeHost(input.host);
    // Only the path: a query string can carry a SHA or a branch, and never needs to be in a trace.
    yield* Effect.annotateCurrentSpan({
      "github.host": host,
      "github.operation": input.operation,
      "github.kind": input.graphql === true ? "graphql" : "rest",
      "http.request.method": input.request.method,
      "url.path": new URL(input.request.url).pathname,
    });
    const { token, fingerprint } = yield* credential(host);
    const scope = yield* SourceControlRateLimit.CredentialScope;
    const key = { provider: "github" as const, host };
    const run = Effect.gen(function* () {
      const lease = yield* limits
        .check(key, input.allowReserve ? { allowPaused: true } : undefined)
        .pipe(
          Effect.tapError((paused) =>
            Effect.annotateCurrentSpan({
              "github.paused": true,
              "github.retry_at": paused.retryAt,
            }),
          ),
        );
      // One deadline covers the headers and the body: a host that answers headers and then stalls
      // must not hold a slot of the shared gate for undici's own five-minute body timeout.
      const { response, collected } = yield* Effect.gen(function* () {
        const response: HttpClientResponse.HttpClientResponse = yield* httpClient
          .execute(
            input.request.pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.setHeaders({
                "x-github-api-version": API_VERSION,
                "user-agent": "t3code",
              }),
            ),
          )
          .pipe(
            // `GitHubApi.send` is the request's span. The client's own span would add `url.full`
            // and `url.query`, which can carry SHAs and branch names, so it is off for GitHub.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          );
        const collected = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: input.maxResponseBytes,
        }).pipe(
          // 204, 304 and many refusals carry no body at all, which is an empty answer.
          Effect.catchIf(
            (error) => error.reason._tag === "EmptyBodyError",
            () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
          ),
        );
        return { response, collected };
      }).pipe(
        Effect.timeout(input.timeout ?? DEFAULT_TIMEOUT),
        Effect.mapError(
          (cause) => new GitHubApiRequestError({ host, operation: input.operation, cause }),
        ),
      );
      const headers = response.headers;
      const status = response.status;
      yield* Effect.annotateCurrentSpan({
        "http.response.status_code": status,
        ...rateLimitAttributes(headers),
      });
      const context = { host, operation: input.operation };
      return yield* Answer.$match(
        classify({
          status,
          headers,
          body: collected.text,
          graphql: input.graphql === true,
          acceptNotModified: input.acceptNotModified,
        }),
        {
          Ok: () =>
            limits.recordSuccess({ ...key, lease }).pipe(
              Effect.as({
                status,
                headers,
                body: collected.text,
                truncated: collected.truncated,
                invalidUtf8: collected.invalidUtf8,
              }),
            ),
          RateLimited: () =>
            Effect.gen(function* () {
              const retryAt = retryAtFrom(headers, yield* Clock.currentTimeMillis);
              yield* limits.recordRateLimit({ ...key, lease, retryAt });
              yield* Effect.annotateCurrentSpan({
                "github.rate_limited": true,
                ...(retryAt === undefined ? {} : { "github.retry_at": retryAt }),
              });
              return yield* new GitHubApiRateLimitError({
                ...context,
                ...(retryAt === undefined ? {} : { retryAt }),
              });
            }),
          // The source may hold a newer token than the one that was refused.
          Unauthorized: () =>
            credentials
              .invalidate(host)
              .pipe(Effect.andThen(Effect.fail(new GitHubApiAuthenticationError(context)))),
          NotFound: () => Effect.fail(new GitHubApiNotFoundError(context)),
          Failed: ({ messages }) =>
            Effect.fail(
              new GitHubApiResponseError({
                ...context,
                status,
                ...(messages === undefined ? {} : { githubErrors: messages }),
              }),
            ),
        },
      );
    });
    // The rate-limit scope follows the credential, so a pause on one account never blocks another.
    return yield* gate
      .withPermit(run)
      .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope || fingerprint));
  });

  const rest: GitHubApi["Service"]["rest"] = (input) => {
    const url = `${gitHubApiUrls(input.host).rest}/${input.path.replace(/^\/+/, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeader("accept", input.accept ?? "application/vnd.github+json"),
    );
    const withEtag =
      input.ifNoneMatch === undefined
        ? base
        : base.pipe(HttpClientRequest.setHeader("if-none-match", input.ifNoneMatch));
    const request =
      input.body === undefined
        ? withEtag
        : withEtag.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    return AllowGitHubReserve.pipe(
      Effect.flatMap((interactive) =>
        send({
          host: input.host,
          operation: input.operation,
          request,
          maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          timeout: input.timeout,
          allowReserve: input.allowReserve ?? interactive,
          acceptNotModified: input.ifNoneMatch !== undefined,
        }),
      ),
    );
  };

  const graphql: GitHubApi["Service"]["graphql"] = Effect.fn("GitHubApi.graphql")(
    function* (input) {
      const host = normalizeHost(input.host);
      const { fingerprint } = yield* credential(host);
      const scope = (yield* SourceControlRateLimit.CredentialScope) || fingerprint;
      const allowReserve = input.allowReserve ?? (yield* AllowGitHubReserve);
      // The document, never its variables: user text (bodies, search terms) travels as variables.
      yield* Effect.annotateCurrentSpan({
        "github.operation": input.operation,
        "github.graphql.query_hash": queryHash(input.query),
        "github.graphql.query":
          input.query.length > TRACED_QUERY_MAX_CHARS
            ? `${input.query.slice(0, TRACED_QUERY_MAX_CHARS)}…`
            : input.query,
      });
      return yield* Effect.gen(function* () {
        const query = yield* budget.query(
          host,
          input.query,
          allowReserve ? { allowReserve: true } : undefined,
        );
        const response = yield* send({
          host,
          operation: input.operation,
          request: HttpClientRequest.post(gitHubApiUrls(host).graphql).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({ query, variables: input.variables ?? {} }),
          ),
          maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          allowReserve,
          acceptNotModified: false,
          graphql: true,
        });
        // A body cut at the byte cap hides any `errors` past the cut and cannot be decoded.
        if (response.truncated) {
          return yield* new GitHubApiResponseError({
            host,
            operation: input.operation,
            status: response.status,
          });
        }
        yield* budget.observe(host, response.body);
        const cost = Option.getOrUndefined(decodeGraphQlCost(response.body));
        if (cost !== undefined) {
          yield* Effect.annotateCurrentSpan({
            "github.graphql.cost": cost.data.rateLimit.cost,
            "github.graphql.remaining": cost.data.rateLimit.remaining,
          });
        }
        return response.body;
      }).pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, scope));
    },
  );

  return GitHubApi.of({ graphql, rest, credential });
});

export const layer = Layer.effect(GitHubApi, make);
