import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isPaused = Schema.is(SourceControlRateLimitPausedError);
const isPullRequestProviderError = Schema.is(PullRequestProviderError);

function rateLimitRetryAt(cause: Cause.Cause<unknown>): number | undefined {
  // Do not hide a defect or another failure alongside an expected pause.
  if (cause.reasons.length !== 1 || !Cause.isFailReason(cause.reasons[0]!)) return undefined;
  let error: unknown = cause.reasons[0].error;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (isPaused(error)) return error.retryAt;
    if (isPullRequestProviderError(error) && error.reason === "rate-limited") return error.retryAt;
    error = error.cause;
  }
  return undefined;
}

export function logThreadPullRequestFailure(
  message: string,
  cause: Cause.Cause<unknown>,
  context: { readonly threadId: string } | { readonly threadIds: ReadonlyArray<string> },
) {
  const retryAt = rateLimitRetryAt(cause);
  return retryAt === undefined
    ? Effect.logWarning(message, { ...context, cause: Cause.pretty(cause) })
    : Effect.logDebug(message, { ...context, retryAt });
}
