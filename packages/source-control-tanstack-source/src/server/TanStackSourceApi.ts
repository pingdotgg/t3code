import * as Clock from "effect/Clock";
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

import * as Credentials from "./TanStackSourceCredentials.ts";
import * as Hosts from "./tanStackSourceHosts.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const MAX_REDIRECTS = 3;
const TIMEOUT = Duration.seconds(30);

export const TanStackSourceApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "forbidden",
  "rate-limited",
  "not-found",
  "failed",
]);

export class TanStackSourceApiError extends Schema.TaggedError<TanStackSourceApiError>()(
  "TanStackSourceApiError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.NullOr(Schema.Int),
    reason: TanStackSourceApiFailure,
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `TanStack Source ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

export interface TanStackSourceApiRequest {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below `/api/v1`, starting with `/`. */
  readonly path: string;
  readonly body?: unknown;
  readonly accept?: string;
}

export interface TanStackSourceApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

export class TanStackSourceApi extends Context.Service<
  TanStackSourceApi,
  {
    readonly request: (
      input: TanStackSourceApiRequest,
    ) => Effect.Effect<string, TanStackSourceApiError>;
    /** `request` with the response headers, for routes that answer in them (job logs). */
    readonly response: (
      input: TanStackSourceApiRequest,
    ) => Effect.Effect<TanStackSourceApiResponse, TanStackSourceApiError>;
  }
>()("@t3tools/source-control-tanstack-source/server/TanStackSourceApi") {}

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof TanStackSourceApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
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
  error: Credentials.TanStackSourceCredentialUnavailableError,
): typeof TanStackSourceApiFailure.Type =>
  error._tag === "TanStackSourceCliMissingError"
    ? "missing-tool"
    : error._tag === "TanStackSourceCliFailedError" ||
        error._tag === "TanStackSourceCliTimeoutError"
      ? "failed"
      : "unauthenticated";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// 307 and 308 keep the method and body; the others only safely repeat a read.
const METHOD_PRESERVING = new Set([307, 308]);

/** A transferred issue answers 301 with its new place; follow it only within this host's API. */
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
    target.pathname.startsWith("/api/v1/")
    ? target.href
    : null;
};

const retryAtFrom = (headers: Readonly<Record<string, string>>, now: number) => {
  const seconds = Number(headers["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1_000 : undefined;
};

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* Credentials.TanStackSourceCredentials;

  const response = Effect.fn("TanStackSourceApi.request")(function* (
    input: TanStackSourceApiRequest,
  ) {
    const fail = (
      fields: Pick<TanStackSourceApiError, "status" | "reason" | "detail"> & {
        readonly cause?: unknown;
        readonly retryAt?: number | undefined;
      },
    ) =>
      new TanStackSourceApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    // A remote or link may name any host; the token only goes to Source's own.
    const host = Hosts.tanStackSourceHost(input.host);
    if (host === null)
      return yield* fail({
        status: null,
        reason: "failed",
        detail: `TanStack Source lives on ${Hosts.TANSTACK_SOURCE_HOSTS.join(" and ")}, not ${input.host}.`,
      });
    const method = input.method ?? "GET";
    yield* Effect.annotateCurrentSpan({
      "tanstack_source.host": host,
      "tanstack_source.operation": input.operation,
      "http.request.method": method,
    });
    const credential = yield* credentials
      .get(host)
      .pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: credentialFailure(cause), detail: cause.message, cause }),
        ),
      );
    const origin = `https://${host}`;
    const send = (url: string) => {
      const base = HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(credential.token)),
        HttpClientRequest.setHeaders({
          accept: input.accept ?? "application/json",
          "user-agent": "t3code",
        }),
      );
      return Effect.gen(function* () {
        const reply = yield* httpClient
          .execute(
            input.body === undefined
              ? base
              : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
          )
          .pipe(
            // Client spans expose query strings carrying branch names.
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            // fetch would carry the bearer token to any redirect target.
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
          );
        return { status: reply.status, headers: reply.headers, text: yield* reply.text };
      }).pipe(
        Effect.timeout(TIMEOUT),
        Effect.mapError((cause) =>
          fail({
            status: null,
            reason: "failed",
            detail: "Could not reach TanStack Source.",
            cause,
          }),
        ),
      );
    };
    let url = `${origin}/api/v1${input.path}`;
    let reply = yield* send(url);
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const next = redirectTarget(method, origin, url, {
        status: reply.status,
        location: reply.headers.location,
      });
      if (next === null) break;
      url = next;
      reply = yield* send(url);
    }
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": reply.status });
    if (reply.status >= 200 && reply.status < 300) return reply;
    // The source may hold a newer token than the one that was refused.
    if (reply.status === 401) yield* credentials.invalidate(host);
    const problem = Option.getOrUndefined(decodeProblem(reply.text));
    return yield* fail({
      status: reply.status,
      reason: reasonForStatus(reply.status),
      detail:
        boundedProblemText(problem?.error ?? problem?.message) ??
        `TanStack Source answered HTTP ${reply.status}.`,
      retryAt:
        reply.status === 429
          ? retryAtFrom(reply.headers, yield* Clock.currentTimeMillis)
          : undefined,
    });
  });

  return TanStackSourceApi.of({
    response,
    request: Effect.fn("TanStackSourceApi.requestText")(function* (input) {
      return (yield* response(input)).text;
    }),
  });
});

export const layer = Layer.effect(TanStackSourceApi, make);
