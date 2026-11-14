import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import type { SourceControlRateLimitRefusal } from "@t3tools/source-control-core/server/driver";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "../sourceControl/sourceControlDefinitions.ts";

const isPaused = Schema.is(SourceControlRateLimitPausedError);
const isPullRequestProviderError = Schema.is(PullRequestProviderError);

function refusal(error: Error): SourceControlRateLimitRefusal | undefined {
  if (isPaused(error)) return { retryAt: error.retryAt };
  if (isPullRequestProviderError(error)) {
    if (error.reason !== "rate-limited") return undefined;
    return error.retryAt === undefined ? {} : { retryAt: error.retryAt };
  }
  for (const driver of BUILT_IN_SOURCE_CONTROL_DRIVER_LIST) {
    const found = driver.rateLimitRefusal?.(error);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Forge errors arrive wrapped, so walk the cause chain for a rate-limit refusal. Only a cause whose
// single failure is a refusal counts; a defect or a second failure beside it still warns.
// Not every forge reports a reset time, so a refusal without one is still a pause.
function rateLimitPause(cause: Cause.Cause<unknown>): SourceControlRateLimitRefusal | undefined {
  if (cause.reasons.length !== 1 || !Cause.isFailReason(cause.reasons[0]!)) return undefined;
  let error: unknown = cause.reasons[0].error;
  let pause: SourceControlRateLimitRefusal | undefined;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    const found = refusal(error);
    if (found?.retryAt !== undefined) return found;
    pause ??= found;
    error = error.cause;
  }
  return pause;
}

/**
 * A quota pause repeats on every sweep until the reset time, so it logs as a single Info line
 * (the pretty console logger spreads structured fields over several lines) instead of a Warn stack.
 */
export function logThreadPullRequestFailure(
  message: string,
  cause: Cause.Cause<unknown>,
  context: { readonly threadId: string } | { readonly threadIds: ReadonlyArray<string> },
) {
  const pause = rateLimitPause(cause);
  if (pause === undefined) {
    return Effect.logWarning(message, { ...context, cause: Cause.pretty(cause) });
  }
  const threadIds = "threadId" in context ? [context.threadId] : context.threadIds;
  // A reset time the host garbled is left out rather than failing the log.
  const until = Option.match(
    Option.fromUndefinedOr(pause.retryAt).pipe(Option.flatMap(DateTime.make)),
    {
      onNone: () => "",
      onSome: (retryAt) => ` until ${DateTime.formatIso(retryAt)}`,
    },
  );
  return Effect.logInfo(`${message}: rate limited${until} (threads: ${threadIds.join(", ")})`);
}
