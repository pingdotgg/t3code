import { RelayProtectedError } from "@t3tools/contracts/relay";
import { clockSkewFromDateHeader, describeClockSkew } from "@t3tools/shared/clockSkew";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { isHttpClientError } from "effect/http/HttpClientError";

// Descriptions carry relay diagnostics and trace IDs, never request credentials.
export class RelayRequestError extends Schema.TaggedError<RelayRequestError>()(
  "RelayRequestError",
  {
    rejection: Schema.Literals(["unauthorized", "forbidden", "rejected", "unavailable"]),
    description: Schema.String,
    clockSkewSeconds: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.description;
  }
}

const isRelayRequestError = Schema.is(RelayRequestError);

export function relayRequestError(cause: unknown): RelayRequestError {
  return isRelayRequestError(cause)
    ? cause
    : new RelayRequestError({
        rejection: "unavailable",
        description: `Could not complete the T3 Connect relay request. ${isHttpClientError(cause) ? `The relay request failed (${cause.reason._tag}).` : "The relay returned an unexpected response."} Check this machine's network connection and relay availability, then retry.`,
      });
}

export const shouldRetryRelayRequest = (error: unknown): boolean =>
  !isRelayRequestError(error) ||
  error.rejection === "unavailable" ||
  error.clockSkewSeconds !== undefined;

/** A relay refusal that came while this machine's clock was too far off to trust. */
export const isRelayClockSkewError = (error: unknown): error is RelayRequestError =>
  isRelayRequestError(error) && error.clockSkewSeconds !== undefined;

function recoveryHint(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayEnvironmentLinkLimitExceededError":
      return "Unlink an unused environment in T3 Connect, then restart T3 Code on this machine.";
    case "RelayAuthInvalidError":
      return "Run `t3 connect login` to check this machine's authorization. If the stored credential was revoked, sign out with `t3 connect logout`, then run `t3 connect` again. Restart T3 Code after signing in.";
    case "RelayEnvironmentLinkProofExpiredError":
    case "RelayEnvironmentLinkProofInvalidError":
      return "Check this machine's date and time. T3 Connect retries expired proofs automatically; update T3 Code if this continues.";
    default:
      return "Retry when the relay is available. If this continues, include the trace ID when reporting it.";
  }
}

export const filterRelayResponse = Effect.fn("cloud.filter_relay_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
  requestDurationMillis = 0,
  requestStartedAtMillis?: number,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const nowMillis = yield* Clock.currentTimeMillis;
  const clockSkewSeconds = clockSkewFromDateHeader(
    response.headers.date,
    nowMillis,
    requestDurationMillis,
  );
  const decoded = yield* HttpClientResponse.schemaBodyJson(RelayProtectedError)(response).pipe(
    Effect.option,
  );
  const ray = response.headers["cf-ray"];
  const requestId = ray && /^[a-zA-Z0-9-]{1,128}$/.test(ray) ? ` Cloudflare Ray ID: ${ray}.` : "";
  const description = Option.isSome(decoded)
    ? `T3 Connect: ${decoded.value.message}. ${recoveryHint(decoded.value)} Trace ID: ${decoded.value.traceId}.`
    : `T3 Connect relay returned HTTP ${response.status} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart T3 Code.${requestId}`;
  // The proof predates any in-flight clock correction. Project the starting
  // wall clock forward with monotonic time to check the clock that signed it.
  if (
    (response.status === 400 || response.status === 401) &&
    clockSkewSeconds === null &&
    requestStartedAtMillis !== undefined &&
    clockSkewFromDateHeader(
      response.headers.date,
      requestStartedAtMillis + requestDurationMillis,
      requestDurationMillis,
    ) !== null
  ) {
    return yield* new RelayRequestError({
      rejection: "unavailable",
      description: `The host computer's clock changed during the T3 Connect relay request. T3 Connect will retry with a fresh proof. Relay response: ${
        Option.isSome(decoded)
          ? `${decoded.value.message}. Trace ID: ${decoded.value.traceId}.`
          : `HTTP ${response.status}.${requestId}`
      }`,
    });
  }
  // Timestamp rejections can clear after clock sync; unrelated HTTP statuses stay permanent.
  const clockSuspected =
    clockSkewSeconds !== null && (response.status === 400 || response.status === 401);
  const platform = yield* HostProcess.Platform;
  const refusal = (rejection: RelayRequestError["rejection"]) =>
    !clockSuspected
      ? new RelayRequestError({ rejection, description })
      : new RelayRequestError({
          rejection,
          // The relay's own recovery advice does not apply until the clock is
          // fixed, so keep only what it said and its trace.
          description: `${describeClockSkew(clockSkewSeconds, platform)} T3 Connect reconnects by itself once the clock is correct. Relay response: ${
            Option.isSome(decoded)
              ? `${decoded.value.message}. Trace ID: ${decoded.value.traceId}.`
              : `HTTP ${response.status}.${requestId}`
          }`,
          clockSkewSeconds,
        });

  // A decoded expired proof remains retryable even without a usable Date header.
  if (
    response.status === 401 &&
    Option.isSome(decoded) &&
    decoded.value._tag === "RelayEnvironmentLinkProofExpiredError"
  ) {
    return yield* refusal("unavailable");
  }
  if (response.status === 401) {
    return yield* refusal("unauthorized");
  }
  if (response.status === 403) {
    return yield* refusal("forbidden");
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408 &&
    response.status !== 429
  ) {
    return yield* refusal("rejected");
  }
  return yield* new RelayRequestError({ rejection: "unavailable", description });
});

export const filterRelayClient = (client: HttpClient.HttpClient) =>
  HttpClient.transformResponse(client, (response) =>
    Effect.gen(function* () {
      const startedAtMillis = yield* Clock.currentTimeMillis;
      const [duration, result] = yield* response.pipe(Effect.timed);
      return yield* filterRelayResponse(result, Duration.toMillis(duration), startedAtMillis);
    }),
  );
