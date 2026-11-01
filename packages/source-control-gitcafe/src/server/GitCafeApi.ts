import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as GitCafeCredentials from "./GitCafeCredentials.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const MAX_REDIRECTS = 3;
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

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      detail: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof GitCafeApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

const MAX_PROBLEM_TEXT = 300;
const boundedProblemText = (text: string | undefined) => {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_PROBLEM_TEXT ? `${line.slice(0, MAX_PROBLEM_TEXT)}…` : line;
};

const credentialFailure = (
  error: GitCafeCredentials.GitCafeCredentialUnavailableError,
): typeof GitCafeApiFailure.Type =>
  error._tag === "GitCafeCliMissingError"
    ? "missing-tool"
    : error._tag === "GitCafeNotSignedInError"
      ? "unauthenticated"
      : "failed";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// 307 and 308 keep the method and body; the others only safely repeat a read.
const METHOD_PRESERVING = new Set([307, 308]);

const redirectTarget = (
  method: string,
  origin: string,
  from: string,
  response: { readonly status: number; readonly location: string | undefined },
): string | null => {
  if (!REDIRECTS.has(response.status) || response.location === undefined) return null;
  if (method !== "GET" && !METHOD_PRESERVING.has(response.status)) return null;
  const target = URL.parse(response.location, from);
  return target !== null &&
    target.origin === origin &&
    target.username === "" &&
    target.password === "" &&
    target.pathname.startsWith("/api/")
    ? target.href
    : null;
};

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* GitCafeCredentials.GitCafeCredentials;

  const request = Effect.fn("GitCafeApi.request")(function* (input: GitCafeApiRequest) {
    const fail = (
      fields: Pick<GitCafeApiError, "status" | "reason" | "detail"> & { cause?: unknown },
    ) =>
      new GitCafeApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    // Remote URLs must not send tokens outside GitCafe's hosts.
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
    const credential = yield* credentials
      .get(host)
      .pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: credentialFailure(cause), detail: cause.message, cause }),
        ),
      );
    const origin = `https://${host}`;
    const method = input.method ?? "GET";
    const send = (url: string) => {
      const base = HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(credential.token)),
        HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
      );
      return Effect.gen(function* () {
        const response = yield* httpClient
          .execute(
            input.body === undefined
              ? base
              : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
          )
          .pipe(
            // Client spans expose query strings containing branch names.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            // fetch would carry the bearer token to any redirect target.
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
          );
        return {
          status: response.status,
          location: response.headers.location,
          text: yield* response.text,
        };
      }).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail({ status: null, reason: "failed", detail: "Could not reach GitCafe.", cause }),
        ),
      );
    };
    // A renumbered pull request (provisional number replaced by the synced GitHub one)
    // answers with a redirect; follow it only within this host's API.
    let url = `${origin}/api${input.path}`;
    let response = yield* send(url);
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const next = redirectTarget(method, origin, url, response);
      if (next === null) break;
      url = next;
      response = yield* send(url);
    }
    const { status, text } = response;
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": status });
    if (status >= 200 && status < 300) return text;
    // The source may hold a newer token than the one that was refused.
    if (status === 401) yield* credentials.invalidate(host);
    const problem = Option.getOrUndefined(decodeProblem(text));
    return yield* fail({
      status,
      reason: reasonForStatus(status),
      detail:
        boundedProblemText(problem?.detail ?? problem?.title) ?? `GitCafe answered HTTP ${status}.`,
    });
  });

  return GitCafeApi.of({ request });
});

export const layer = Layer.effect(GitCafeApi, make);
