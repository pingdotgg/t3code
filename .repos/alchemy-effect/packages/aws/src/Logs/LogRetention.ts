import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { toSeconds } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** Retention policy for a CloudWatch log group an Alchemy resource writes to. */
export interface LogRetentionConfig {
  /**
   * How long to retain logs, e.g. `"2 weeks"`, or `"forever"` to clear the
   * retention policy. Rounded up to the nearest CloudWatch-supported
   * retention. When omitted the log group's existing retention is left
   * untouched (new log groups default to never-expire).
   */
  retention?: Duration.Input | "forever";
}

/** CloudWatch Logs' allowed retention values, in days, ascending. */
const LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288,
  3653,
];

/**
 * Apply a {@link LogRetentionConfig.retention} to an existing log group:
 * round the duration UP to the nearest CloudWatch-supported retention, or
 * clear the policy for `"forever"`. Leaves the group untouched when unset.
 */
export const syncLogGroupRetention = Effect.fn(function* ({
  logGroupName,
  retention,
}: {
  logGroupName: string;
  retention: Duration.Input | "forever" | undefined;
}) {
  if (retention === undefined) {
    return;
  }
  if (retention === "forever") {
    yield* logs
      .deleteRetentionPolicy({ logGroupName })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    return;
  }
  const days = Math.max(1, Math.ceil((toSeconds(retention) ?? 0) / 86_400));
  yield* logs.putRetentionPolicy({
    logGroupName,
    retentionInDays:
      LOG_RETENTION_DAYS.find((allowed) => allowed >= days) ??
      LOG_RETENTION_DAYS[LOG_RETENTION_DAYS.length - 1]!,
  });
});
