import * as Schema from "effect/Schema";

import { makeProviderFailure } from "../ProviderFailure.ts";
import type { AcpAdapterV2ExtensionContext } from "./AcpAdapterV2.ts";

// Vibe application codes are provider-specific, not ACP-wide error codes.
export const MISTRAL_VIBE_RATE_LIMITED = -31001;

const SessionRetryingNotification = Schema.Struct({
  sessionId: Schema.String,
  category: Schema.Literals(["rate_limited", "server_error", "timed_out", "connection", "unknown"]),
  detail: Schema.String,
});

/** Vibe v2.25.5 reports SDK backoff through this ACP extension. */
export function registerMistralVibeAcpExtensions(context: AcpAdapterV2ExtensionContext) {
  return context.runtime.handleExtNotification(
    "_session/retrying",
    SessionRetryingNotification,
    (notice) =>
      context.reportProviderRetry({
        sessionId: notice.sessionId,
        failure: makeProviderFailure({
          message: notice.detail,
          class:
            notice.category === "rate_limited"
              ? "usage_limit"
              : notice.category === "unknown"
                ? "provider_error"
                : "transport_error",
          retryable: true,
        }),
      }),
  );
}
