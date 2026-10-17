import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);

export const GitCafeApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class GitCafeApiError extends Schema.TaggedError<GitCafeApiError>()("GitCafeApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: GitCafeApiFailure,
  detail: Schema.String,
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitCafe ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

export interface GitCafeApiRequest {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
}

export class GitCafeApi extends Context.Service<
  GitCafeApi,
  {
    readonly request: (input: GitCafeApiRequest) => Effect.Effect<string, GitCafeApiError>;
  }
>()("@t3tools/source-control-gitcafe/server/GitCafeApi") {}

const reasonForStatus = (status: number): typeof GitCafeApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

const credentialFailure = (
  error: GitCafeCredentials.GitCafeCredentialUnavailableError,
): typeof GitCafeApiFailure.Type =>
  error._tag === "GitCafeCliMissingError"
    ? "missing-tool"
    : error._tag === "GitCafeNotSignedInError"
      ? "unauthenticated"
      : "failed";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GitCafeCredentials.GitCafeCredentials;

  const request = Effect.fn("GitCafeApi.request")(function* (input: GitCafeApiRequest) {
    const fail = (
      fields: Pick<GitCafeApiError, "status" | "reason" | "detail"> & {
        cause?: unknown;
        retryAt?: number;
      },
    ) =>
      new GitCafeApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    // The host comes from a remote URL, so a token never leaves for one GitCafe does not own.
    const host = GitCafeHosts.gitCafeHost(input.host);
    if (host === null)
      return yield* fail({
        status: null,
        reason: "failed",
        detail: `GitCafe lives on ${GitCafeHosts.GITCAFE_HOSTS.join(" and ")}, not ${input.host}.`,
      });
    yield* Effect.annotateCurrentSpan({
      "gitcafe.host": host,
      "gitcafe.operation": input.operation,
      "http.request.method": input.method ?? "GET",
    });
    const credential = yield* credentials.get(host).pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason: credentialFailure(cause),
          detail: "GitCafe credentials are unavailable.",
          cause,
        }),
      ),
    );
    const base = HttpClientRequest.make(input.method ?? "GET")(
      `https://${host}/api${input.path}`,
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credential.token)),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
    );
    const { status, text, retryAfter } = yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
        )
        .pipe(
          // The client's own span would record the query string, which can carry branch names.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          // fetch would follow a redirect itself and keep the bearer token on a same-origin hop;
          // GitCafe's API never redirects a request it serves, so a 3xx is answered as a failure.
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        );
      return {
        status: response.status,
        text: yield* response.text,
        retryAfter: response.headers["retry-after"],
      };
    }).pipe(
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach GitCafe.", cause }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": status });
    if (status >= 200 && status < 300) return text;
    // The source may hold a newer token than the one that was refused.
    if (status === 401) yield* credentials.invalidate(host);
    const retryAt =
      status === 429 ? retryAtFromHeader(retryAfter, yield* Clock.currentTimeMillis) : undefined;
    return yield* fail({
      status,
      reason: reasonForStatus(status),
      detail: `GitCafe answered HTTP ${status}.`,
      ...(retryAt === undefined ? {} : { retryAt }),
      cause: { status, body: text.slice(0, 2048) },
    });
  });

  return GitCafeApi.of({ request });
});

export const layer = Layer.effect(GitCafeApi, make);
