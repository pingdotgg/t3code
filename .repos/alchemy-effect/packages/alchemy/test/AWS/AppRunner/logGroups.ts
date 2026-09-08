import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The two CloudWatch log groups App Runner auto-creates for a service.
 *
 * Deliberately spelled out here rather than imported from the provider:
 * a wrong format in the provider would make its reap miss the real groups,
 * and only an independently-derived name catches that.
 */
export const logGroupNamesFor = (serviceName: string, serviceId: string) => [
  `/aws/apprunner/${serviceName}/${serviceId}/application`,
  `/aws/apprunner/${serviceName}/${serviceId}/service`,
];

/** Which of the given log groups currently exist, in order. */
export const observeLogGroups = (logGroupNames: readonly string[]) =>
  Effect.forEach(logGroupNames, (logGroupName) =>
    logs
      .describeLogGroups({ logGroupNamePrefix: logGroupName, limit: 1 })
      .pipe(
        Effect.map((response) =>
          (response.logGroups ?? []).some(
            (group) => group.logGroupName === logGroupName,
          ),
        ),
      ),
  );

/**
 * Wait until every group exists. App Runner creates them around the first
 * deployment, which can lag the service reaching RUNNING by a few seconds.
 */
export const awaitLogGroups = (logGroupNames: readonly string[]) =>
  observeLogGroups(logGroupNames).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (present) => present.every(Boolean),
      times: 24,
    }),
  );

/** Delete the groups out-of-band (cleanup for retained-log-group coverage). */
export const deleteLogGroups = (logGroupNames: readonly string[]) =>
  Effect.forEach(logGroupNames, (logGroupName) =>
    logs
      .deleteLogGroup({ logGroupName })
      .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
  );
