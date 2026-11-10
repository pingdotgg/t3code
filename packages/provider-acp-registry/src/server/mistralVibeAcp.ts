import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

// Mistral Vibe's application rate-limit code, outside ACP.
export const MISTRAL_VIBE_RATE_LIMITED = -31001;

const MistralVibeSessionRetrying = Schema.Struct({
  sessionId: Schema.String,
  category: Schema.Literals(["rate_limited", "server_error", "timed_out", "connection", "unknown"]),
  detail: Schema.String,
});

// Largest valid Date millisecond value; rejects garbage that Date.parse turns into huge numbers.
const LATEST_DATE_MS = 8.64e15;

/** "Your usage window resets at 2026-10-13T10:45:52Z." */
const NAMED_RESET =
  /\b(?:resets?|retry)\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;
/** "Retry after 30 seconds." / "available in 5 minutes." */
const RETRY_AFTER =
  /\b(?:retry\s+(?:after|in)|available\s+in)\s+(\d+)\s*(milliseconds?|ms|seconds?|secs?|minutes?|mins?|hours?)\b/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

/**
 * Mistral Vibe surfaces quota resets only as free text inside the `_session/retrying`
 * detail and the -31001 prompt error, so read the latest future reset the text names.
 */
export function mistralVibeUsageLimitResetAt(
  detail: string | undefined,
  nowMs: number,
): string | null {
  if (detail === undefined) return null;
  const candidates: number[] = [];
  const named = detail.match(NAMED_RESET)?.[1];
  if (named !== undefined) candidates.push(Date.parse(named));
  const retryAfter = detail.match(RETRY_AFTER);
  if (retryAfter?.[1] !== undefined && retryAfter[2] !== undefined) {
    const amount = Number(retryAfter[1]);
    const unit = UNIT_MS[retryAfter[2].toLowerCase()];
    if (unit !== undefined) candidates.push(nowMs + amount * unit);
  }
  const future = candidates.filter(
    (ms) => Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return future.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...future))) : null;
}

/** Mistral Vibe (v2.25.5) reports SDK backoff through this ACP extension. */
export function registerMistralVibeAcpExtensions(context: AcpAdapterV2ExtensionContext) {
  return context.runtime.handleExtNotification(
    "_session/retrying",
    MistralVibeSessionRetrying,
    (notice) =>
      Effect.gen(function* () {
        const usageLimited = notice.category === "rate_limited";
        return yield* context.reportProviderRetry({
          sessionId: notice.sessionId,
          failure: makeProviderFailure({
            message: notice.detail,
            class: usageLimited
              ? "usage_limit"
              : notice.category === "unknown"
                ? "provider_error"
                : "transport_error",
            retryable: true,
            ...(usageLimited
              ? {
                  resetAt: mistralVibeUsageLimitResetAt(
                    notice.detail,
                    DateTime.toEpochMillis(yield* DateTime.now),
                  ),
                }
              : {}),
          }),
        });
      }),
  );
}

/** The -31001 prompt refusal is the same quota signal; parse its reset from the error text. */
export function mistralVibePromptFailure(cause: EffectAcpErrors.AcpRequestError, nowMs: number) {
  return makeProviderFailure({
    cause,
    message: cause.errorMessage,
    code: String(cause.code),
    class: "usage_limit",
    resetAt: mistralVibeUsageLimitResetAt(cause.errorMessage, nowMs),
  });
}
