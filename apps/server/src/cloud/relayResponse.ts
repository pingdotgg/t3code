import { RelayProtectedError } from "@t3tools/contracts/relay";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { isHttpClientError } from "effect/http/HttpClientError";

/** Only unavailable is retryable. Descriptions expose relay explanations and trace IDs, never request details. */
export class RelayRequestError extends Schema.TaggedError<RelayRequestError>()(
  "RelayRequestError",
  {
    rejection: Schema.Literals(["unauthorized", "forbidden", "rejected", "unavailable"]),
    description: Schema.String,
    /** How long the relay asked callers to wait (`Retry-After`) before retrying. */
    retryAfterMillis: Schema.optionalKey(Schema.Number),
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
  !isRelayRequestError(error) || error.rejection === "unavailable";

/** The relay answered and asked to be retried later; nothing local is wrong. */
export const isRelayUnavailable = (error: unknown): boolean =>
  isRelayRequestError(error) && error.rejection === "unavailable";

// Retry-After is either delay-seconds or an HTTP date (RFC 9110 §10.2.3).
const MAX_RELAY_RETRY_AFTER_MILLIS = 15 * 60 * 1000;
function parseRetryAfterMillis(value: string | undefined, nowMillis: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const millis = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMillis;
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return Math.min(millis, MAX_RELAY_RETRY_AFTER_MILLIS);
}

/** The relay's requested wait, found anywhere in a failure's cause chain. */
export function relayRetryAfterMillis(error: unknown): number | undefined {
  for (let current = error, depth = 0; depth < 8; depth++) {
    if (isRelayRequestError(current)) return current.retryAfterMillis;
    if (typeof current !== "object" || current === null || !("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

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

export const filterRelayResponse = Effect.fn("cloud.filter_relay_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return response;
  const decoded = yield* HttpClientResponse.schemaBodyJson(RelayProtectedError)(response).pipe(
    Effect.option,
  );
  const ray = response.headers["cf-ray"];
  const requestId = ray && /^[a-zA-Z0-9-]{1,128}$/.test(ray) ? ` Cloudflare Ray ID: ${ray}.` : "";
  const description = Option.isSome(decoded)
    ? `T3 Connect: ${decoded.value.message}. ${recoveryHint(decoded.value)} Trace ID: ${decoded.value.traceId}.`
    : `T3 Connect relay returned HTTP ${response.status} without a recognized error response. Check relay access and any proxy or firewall restrictions, then restart T3 Code.${requestId}`;

  // Only a schema-decoded expired-proof 401 is retryable for clock skew; every other 401 is permanent.
  if (
    response.status === 401 &&
    Option.isSome(decoded) &&
    decoded.value._tag === "RelayEnvironmentLinkProofExpiredError"
  ) {
    return yield* new RelayRequestError({ rejection: "unavailable", description });
  }
  if (response.status === 401) {
    return yield* new RelayRequestError({ rejection: "unauthorized", description });
  }
  if (response.status === 403) {
    return yield* new RelayRequestError({ rejection: "forbidden", description });
  }
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 408 &&
    response.status !== 429
  ) {
    return yield* new RelayRequestError({ rejection: "rejected", description });
  }
  const retryAfterMillis = parseRetryAfterMillis(
    response.headers["retry-after"],
    yield* Clock.currentTimeMillis,
  );
  return yield* new RelayRequestError({
    rejection: "unavailable",
    description,
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
  });
});
