import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isPaused = Schema.is(SourceControlRateLimitPausedError);
const isPullRequestProviderError = Schema.is(PullRequestProviderError);

// A pause surfaces wrapped: the branch lookup nests SourceControlRateLimitPausedError inside
// SourceControlProviderError, and the summary read nests a rate-limited PullRequestProviderError
// inside PullRequestOperationError. A defect or a second failure next to the pause still warns.
// A rate-limited provider error is a pause even without retryAt: GitHub omits the reset headers
// on some refusals, so the timestamp is taken from a deeper typed pause when one exists and is
// otherwise left out rather than invented.
function rateLimitPause(cause: Cause.Cause<unknown>): { readonly retryAt?: number } | undefined {
  if (cause.reasons.length !== 1 || !Cause.isFailReason(cause.reasons[0]!)) return undefined;
  let error: unknown = cause.reasons[0].error;
  let pause: { readonly retryAt?: number } | undefined;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (isPaused(error)) return { retryAt: error.retryAt };
    if (isPullRequestProviderError(error) && error.reason === "rate-limited") {
      if (error.retryAt !== undefined) return { retryAt: error.retryAt };
      pause ??= {};
    }
    error = error.cause;
  }
  return pause;
}

/**
 * Quota admission already refuses background GitHub reads until the reset time, so every sweep
 * during a pause would otherwise repeat the full warning stack.
 */
export function logThreadPullRequestFailure(
  message: string,
  cause: Cause.Cause<unknown>,
  context: { readonly threadId: string } | { readonly threadIds: ReadonlyArray<string> },
) {
  const pause = rateLimitPause(cause);
  return pause === undefined
    ? Effect.logWarning(message, { ...context, cause: Cause.pretty(cause) })
    : Effect.logDebug(message, { ...context, ...pause });
}
