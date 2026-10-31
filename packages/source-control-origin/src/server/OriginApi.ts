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

import * as OriginCredentials from "./OriginCredentials.ts";
import { ORIGIN_API_BASE, ORIGIN_API_ORIGIN } from "./originHosts.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);

export const OriginApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class OriginApiError extends Schema.TaggedError<OriginApiError>()("OriginApiError", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: OriginApiFailure,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Origin ${this.operation} failed: ${this.detail}`;
  }
}

export interface OriginApiRequest {
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
}

export class OriginApi extends Context.Service<
  OriginApi,
  {
    readonly request: (input: OriginApiRequest) => Effect.Effect<string, OriginApiError>;
  }
>()("@t3tools/source-control-origin/server/OriginApi") {}

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      detail: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof OriginApiFailure.Type =>
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
  error: OriginCredentials.OriginCredentialUnavailableError,
): typeof OriginApiFailure.Type =>
  error._tag === "OriginCliMissingError"
    ? "missing-tool"
    : error._tag === "OriginNotSignedInError"
      ? "unauthenticated"
      : "failed";

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* OriginCredentials.OriginCredentials;

  const request = Effect.fn("OriginApi.request")(function* (input: OriginApiRequest) {
    const fail = (
      fields: Pick<OriginApiError, "status" | "reason" | "detail"> & { cause?: unknown },
    ) =>
      new OriginApiError({
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    if (!input.path.startsWith("/"))
      return yield* fail({
        status: null,
        reason: "failed",
        detail: "Origin API paths must start with /.",
      });
    yield* Effect.annotateCurrentSpan({
      "origin.operation": input.operation,
      "http.request.method": input.method ?? "GET",
    });
    const credential = yield* credentials
      .get()
      .pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: credentialFailure(cause), detail: cause.message, cause }),
        ),
      );
    const method = input.method ?? "GET";
    const url = `${ORIGIN_API_BASE}${input.path}`;
    const base = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credential.token)),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
    );
    const response = yield* httpClient
      .execute(
        input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
      )
      .pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        Effect.flatMap((res) =>
          Effect.map(res.text, (text) => ({
            status: res.status,
            location: res.headers.location,
            text,
          })),
        ),
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail({ status: null, reason: "failed", detail: "Could not reach Origin.", cause }),
        ),
      );
    // Never follow redirects: the bearer must not leave api.cursor.com.
    if (response.status >= 300 && response.status < 400) {
      const location = response.location;
      const target = location === undefined ? null : URL.parse(location, url);
      if (
        target !== null &&
        (target.origin !== ORIGIN_API_ORIGIN ||
          target.username !== "" ||
          target.password !== "" ||
          !target.pathname.startsWith("/v1/origin/"))
      )
        return yield* fail({
          status: response.status,
          reason: "failed",
          detail: "Origin redirected outside its API host.",
        });
      return yield* fail({
        status: response.status,
        reason: "failed",
        detail: "Origin redirected; refusing to follow with the bearer token.",
      });
    }
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status });
    if (response.status >= 200 && response.status < 300) return response.text;
    if (response.status === 401) yield* credentials.invalidate();
    const problem = Option.getOrUndefined(decodeProblem(response.text));
    return yield* fail({
      status: response.status,
      reason: reasonForStatus(response.status),
      detail:
        boundedProblemText(
          problem?.detail ?? problem?.message ?? problem?.title ?? problem?.error,
        ) ?? `Origin answered HTTP ${response.status}.`,
    });
  });

  return OriginApi.of({ request });
});

export const layer = Layer.effect(OriginApi, make);
