import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay";
import * as Schema from "effect/Schema";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a T3 Connect request failed. */
export function relayFailureReason(cause: unknown): string | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current) || (isRequestFailed(current) && current.status === 504)) {
      return "T3 Connect timed out. Try again.";
    }
    if (isRequestFailed(current)) {
      if (current.transportFailed) return "Could not reach T3 Connect. Check your network.";
      if (current.relayError?._tag === "RelayInternalError" || (current.status ?? 0) >= 500) {
        return "T3 Connect is unavailable. Try again.";
      }
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}
