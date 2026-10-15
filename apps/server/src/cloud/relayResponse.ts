import { RelayProtectedError } from "@t3tools/contracts/relay";
import { clockSkewFromDateHeader, describeClockSkew } from "@t3tools/shared/clockSkew";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { isHttpClientError } from "effect/http/HttpClientError";

/**
 * A relay request that did not succeed. `unavailable` means it may succeed on
 * retry; the relay refused the other kinds. A refusal with `clockSkewSeconds`
 * happened while this machine's clock was that far from the relay's, so it is
 * retried in case fixing the clock is all it needs. The description is safe to show: it
 * carries the relay's own explanation and trace ID, never request details.
 */
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

/**
 * Whether a failure may succeed on retry: anything but a relay refusal, unless
 * the clock was off when the relay refused.
 */
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
      return "Check this machine's date and time, update T3 Code, then restart it.";
    default:
      return "Retry when the relay is available. If this continues, include the trace ID when reporting it.";
  }
}

/** Preserve relay diagnostics before converting permanent rejections into non-retryable errors. */
export const filterRelayResponse = Effect.fn("cloud.filter_relay_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const clockSkewSeconds = clockSkewFromDateHeader(
    response.headers.date,
    yield* Clock.currentTimeMillis,
  );
  const decoded = yield* HttpClientResponse.schemaBodyJson(RelayProtectedError)(response).pipe(
    Effect.option,
  );
  const ray = response.headers["cf-ray"];
  const requestId = ray && /^[a-zA-Z0-9-]{1,128}$/.test(ray) ? ` Cloudflare Ray ID: ${ray}.` : "";
  const description = Option.isSome(decoded)
    ? `T3 Connect: ${decoded.value.message}. ${recoveryHint(decoded.value)} Trace ID: ${decoded.value.traceId}.`
    : `T3 Connect relay returned HTTP ${response.status} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart T3 Code.${requestId}`;
  // The relay checks the timestamps this machine signs against its own clock
  // and answers 400 or 401 when they fall outside its window. A skewed clock
  // explains that refusal, and the request cannot succeed until it is fixed.
  // Other refusals (a tunnel limit, a missing link) are about the request.
  const clockSuspected =
    clockSkewSeconds !== null && (response.status === 400 || response.status === 401);
  const platform = yield* HostProcess.Platform;
  const refusal = (rejection: "unauthorized" | "forbidden" | "rejected") =>
    !clockSuspected
      ? new RelayRequestError({ rejection, description })
      : new RelayRequestError({
          rejection,
          // The relay's own recovery advice does not apply until the clock is
          // fixed, so keep only what it said and its trace.
          description: `${describeClockSkew(clockSkewSeconds, platform)} Relay response: ${
            Option.isSome(decoded)
              ? `${decoded.value.message}. Trace ID: ${decoded.value.traceId}.`
              : `HTTP ${response.status}.${requestId}`
          }`,
          clockSkewSeconds,
        });

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
