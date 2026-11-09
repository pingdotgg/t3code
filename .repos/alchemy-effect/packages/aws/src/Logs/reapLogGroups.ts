import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Delete every CloudWatch log group whose name starts with `prefix`.
 *
 * For resources whose SERVICE (not alchemy) creates per-resource log groups
 * on their behalf — RDS log exports (`/aws/rds/instance/<id>/<type>`),
 * CloudHSM audit logs (`/aws/cloudhsm/<clusterId>`) — and leaves them behind
 * when the resource is deleted. The owning provider calls this after the
 * resource is gone so the groups don't leak (cf. Lambda's `/aws/lambda/<fn>`
 * reap in `Lambda/Function.ts`).
 *
 * Callers must pass a prefix that is unique to the resource (end it with `/`
 * when the id is a path segment) so a sibling's groups are never matched.
 *
 * Best-effort and bounded: log cleanup is auxiliary to the already-completed
 * resource delete, so a missing group is success and any other failure or a
 * slow API only logs a warning.
 *
 * Internal scaffolding — NOT exported from the Logs service `index.ts`.
 */
export const reapLogGroupsByPrefix = (prefix: string) =>
  logs.describeLogGroups.pages({ logGroupNamePrefix: prefix }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.logGroups ?? [])),
    Stream.mapEffect(
      (group) =>
        group.logGroupName === undefined
          ? Effect.void
          : logs.deleteLogGroup({ logGroupName: group.logGroupName }).pipe(
              Effect.retry({
                while: (e) =>
                  e._tag === "OperationAbortedException" ||
                  e._tag === "ServiceUnavailableException",
                schedule: Schedule.exponential("250 millis"),
                times: 6,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
      { concurrency: 4 },
    ),
    Stream.runDrain,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.logWarning(`Timed out reaping log groups ${prefix}*`),
    }),
    Effect.catch((e) => Effect.logWarning(`Failed to reap log groups ${prefix}*: ${e._tag}`)),
  );
