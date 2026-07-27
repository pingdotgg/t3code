import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import { every } from "@/AWS/ECS/Schedule.ts";
import { Task } from "@/AWS/ECS/Task.ts";
import * as Test from "@/Test/Alchemy";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// `AWS.ECS.every` synthesizes an EventBridge Scheduler schedule plus the
// invoke role required to `ecs:RunTask` the target definition. Deploy a
// cluster + external busybox task + schedule, verify the schedule wiring
// out-of-band via the Scheduler API (expression, ECS target, network
// config, role), then destroy and verify the schedule is gone.
test.provider(
  "every schedules an ECS RunTask target",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { subnetIds } = yield* getDefaultVpcNetwork;
      const subnets = subnetIds.slice(0, 2);

      const { scheduleName, taskDefinitionArn, clusterArn } =
        yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("EveryCluster", {
              clusterName: "alchemy-test-ecs-every",
            });
            const task = yield* Task("EveryTask", {
              image: "busybox:stable",
              command: ["sh", "-c", "echo alchemy-ecs-every"],
              cpu: 256,
              memory: 512,
              taskName: "alchemy-test-ecs-every",
            });
            // The id doubles as the schedule's physical name.
            const schedule = yield* every(
              "alchemy-test-ecs-every-heartbeat",
              "cron(0 3 * * ? *)",
              { cluster, task, subnets },
            );
            return {
              scheduleName: schedule.scheduleName,
              taskDefinitionArn: task.taskDefinitionArn,
              clusterArn: cluster.clusterArn,
            };
          }),
        );

      // Observe the schedule out-of-band: the cron expression passes
      // through untouched, and the ECS target carries the task definition,
      // the cluster as the target ARN, the awsvpc network config, and the
      // synthesized invoke role.
      const described = yield* scheduler.getSchedule({
        Name: scheduleName,
      });
      expect(described.ScheduleExpression).toBe("cron(0 3 * * ? *)");
      expect(described.Target?.Arn).toBe(clusterArn);
      expect(described.Target?.EcsParameters?.TaskDefinitionArn).toBe(
        taskDefinitionArn,
      );
      expect(described.Target?.EcsParameters?.LaunchType).toBe("FARGATE");
      expect(
        described.Target?.EcsParameters?.NetworkConfiguration
          ?.awsvpcConfiguration?.Subnets,
      ).toEqual(subnets);
      expect(described.Target?.RoleArn).toContain(":role/");

      yield* stack.destroy();

      const gone = yield* scheduler
        .getSchedule({ Name: scheduleName })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(gone).toBeUndefined();
    }),
  { timeout: 240_000 },
);
