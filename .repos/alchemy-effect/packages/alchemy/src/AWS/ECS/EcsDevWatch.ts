/** @effect-diagnostics anyUnknownInErrorContext:off */

/**
 * INTERNAL — shared change-trigger and task-restart machinery for the floci
 * ECS dev providers ([FlociTaskProvider](./FlociTaskProvider.ts),
 * [FlociServiceProvider](./FlociServiceProvider.ts)). NOT exported from the
 * service `index.ts`.
 */

import * as ecs from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";

export { imageSourceTrigger } from "../Local/ImageSourceTrigger.ts";

/** The family segment of a task definition revision ARN. */
const familyOfArn = (arn: string | undefined) =>
  arn?.split("/").pop()?.split(":")[0];

/**
 * Restart every RUNNING task of `family` that is not yet on
 * `nextTaskDefinitionArn`:
 *
 * - **standalone** tasks (launched via `RunTask`, `startedBy` ≠ the service
 *   scheduler) are stopped and re-run on the new revision in the same
 *   cluster/launch type;
 * - **service-managed** tasks (`startedBy: "ecs-svc"` in floci) are only
 *   stopped — the service scheduler relaunches them on the service's
 *   current (freshly-updated) task definition.
 *
 * Bounded: one `listClusters` page, one `listTasks`/`describeTasks` round
 * per cluster.
 */
export const restartFamilyTasks = Effect.fn(function* (options: {
  family: string;
  nextTaskDefinitionArn: string;
  /** Restart the service scheduler's tasks instead of standalone ones. */
  serviceManaged: boolean;
}) {
  const clusters = yield* ecs.listClusters({});
  let restarted = 0;
  for (const cluster of clusters.clusterArns ?? []) {
    const listed = yield* ecs
      .listTasks({
        cluster,
        family: options.family,
        desiredStatus: "RUNNING",
      })
      .pipe(
        Effect.catchTag("ClusterNotFoundException", () =>
          Effect.succeed({ taskArns: [] as string[] }),
        ),
      );
    const taskArns = listed.taskArns ?? [];
    if (taskArns.length === 0) continue;
    const described = yield* ecs.describeTasks({ cluster, tasks: taskArns });
    for (const task of described.tasks ?? []) {
      if (task.taskArn === undefined) continue;
      // Defensive re-filters: an emulator that ignores the list filters
      // still only restarts RUNNING tasks of exactly this family.
      if (task.lastStatus !== "RUNNING") continue;
      if (familyOfArn(task.taskDefinitionArn) !== options.family) continue;
      if (task.taskDefinitionArn === options.nextTaskDefinitionArn) continue;
      const isServiceManaged = task.startedBy === "ecs-svc";
      if (isServiceManaged !== options.serviceManaged) continue;
      yield* ecs.stopTask({
        cluster,
        task: task.taskArn,
        reason: "alchemy dev hot swap",
      });
      if (!options.serviceManaged) {
        yield* ecs.runTask({
          cluster,
          taskDefinition: options.nextTaskDefinitionArn,
          count: 1,
          launchType: task.launchType ?? "EC2",
        });
      }
      restarted++;
    }
  }
  return restarted;
});
