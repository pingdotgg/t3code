import { type IssueTrackerAuth } from "@t3tools/issue-tracker-core/IssueTrackerAuth";
import {
  type IssueTrackerError,
  NotFound,
  RateLimited,
  Unauthorized,
  Unavailable,
} from "@t3tools/issue-tracker-core/errors";
import type { RateLimitObservation } from "@t3tools/issue-tracker-core/IssueTracker";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 20_000;

const GraphqlEnvelope = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(Schema.String),
        extensions: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
      }),
    ),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(GraphqlEnvelope);

export interface LinearTransportOptions {
  readonly auth: IssueTrackerAuth;
  readonly endpoint?: string;
  /** Called with the limits of every response so callers can back off before Linear says 429. */
  readonly observeRateLimit?: (observation: RateLimitObservation) => Effect.Effect<void>;
}

export type LinearRequest = <A>(
  query: string,
  variables: Record<string, unknown>,
  schema: Schema.Decoder<A>,
) => Effect.Effect<A, IssueTrackerError>;

const numberHeader = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

type GraphqlError = NonNullable<typeof GraphqlEnvelope.Type.errors>[number];

const errorCode = (error: GraphqlError): string =>
  String(error.extensions?.code ?? error.extensions?.type ?? "").toLowerCase();

function classifyGraphqlErrors(
  errors: ReadonlyArray<GraphqlError>,
  retryAfterSeconds: number,
): IssueTrackerError | null {
  if (errors.some((error) => errorCode(error).includes("ratelimit"))) {
    return new RateLimited({ retryAfterSeconds });
  }
  if (errors.some((error) => /authenticat/u.test(errorCode(error)))) return new Unauthorized();
  const notFound = errors.find((error) => /not found/iu.test(error.message ?? ""));
  if (notFound !== undefined) return new NotFound({ message: "Linear could not find that item." });
  return null;
}

/**
 * One GraphQL round trip with Linear's failure modes mapped onto tracker errors. Error messages
 * are fixed text: neither the Authorization header nor response bodies are echoed anywhere.
 */
export const makeLinearRequest = Effect.fn("LinearTransport.make")(function* (
  options: LinearTransportOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;

  const request: LinearRequest = Effect.fn("LinearTransport.request")(function* <A>(
    query: string,
    variables: Record<string, unknown>,
    schema: Schema.Decoder<A>,
  ) {
    const authorization = yield* options.auth.authorizationHeader;
    const response = yield* client
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({
            Authorization: authorization,
            "Content-Type": "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.mapError(() => new Unavailable({ message: "Couldn't reach Linear." })),
      );

    const nowMs = yield* Clock.currentTimeMillis;
    const remaining = numberHeader(response.headers["x-ratelimit-requests-remaining"]);
    const resetsAtMs = numberHeader(response.headers["x-ratelimit-requests-reset"]);
    if (options.observeRateLimit !== undefined && (remaining !== null || resetsAtMs !== null)) {
      yield* options.observeRateLimit({ remaining, resetsAtMs });
    }
    const retryAfterHeader = numberHeader(response.headers["retry-after"]);
    const retryAfterSeconds =
      retryAfterHeader ??
      (resetsAtMs !== null && resetsAtMs > nowMs
        ? Math.ceil((resetsAtMs - nowMs) / 1000)
        : DEFAULT_RETRY_AFTER_SECONDS);

    if (response.status === 401) return yield* new Unauthorized();
    if (response.status === 429) return yield* new RateLimited({ retryAfterSeconds });

    const body = yield* response.json.pipe(Effect.flatMap(decodeEnvelope), Effect.option);
    if (body._tag === "None") {
      return yield* new Unavailable({
        message:
          response.status >= 500
            ? "Linear is unavailable right now."
            : "Linear sent a response T3 Code could not read.",
      });
    }
    const { data, errors } = body.value;
    if (errors !== undefined && errors.length > 0) {
      const classified = classifyGraphqlErrors(errors, retryAfterSeconds);
      if (classified !== null) return yield* classified;
      // Partial data alongside field errors is usable; no data at all is a failed request.
      if (data === undefined || data === null) {
        return yield* new Unavailable({ message: "Linear rejected the request." });
      }
    }
    if (response.status === 403) return yield* new Unauthorized();
    if (response.status >= 400 && (data === undefined || data === null)) {
      return yield* new Unavailable({
        message:
          response.status >= 500
            ? "Linear is unavailable right now."
            : "Linear rejected the request.",
      });
    }
    return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError(
        () => new Unavailable({ message: "Linear sent a response T3 Code could not read." }),
      ),
    );
  });

  return request;
});
