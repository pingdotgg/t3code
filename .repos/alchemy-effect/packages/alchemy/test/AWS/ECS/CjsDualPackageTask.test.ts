import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import CjsDualPackageTaskLive, {
  CjsDualPackageTask,
} from "./fixtures/pg-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live behavioral proof for CommonJS dual-package resolution: a deployed
// task whose program imports `pg` (a CJS consumer of the dual-package
// `pg-pool`, whose exports list `import` before `require`). With the former
// bundler conditions (`"import"` in the set for both import kinds) the
// bundle died AT LOAD with `TypeError: The superclass is not a constructor`
// and the container exited 1; the fixture must boot, construct a Pool, and
// exit 0. The unit-level pin is test/Bundle/ConditionNames.test.ts — this
// is the same defect observed from the cloud.
//
// Docker + ECR + Fargate placement is minutes of wall clock, so like the
// Task e2e smoke test it is gated out of the default sweep: run it
// explicitly with `AWS_TEST_SLOW=1`.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "task importing a CJS dual-package consumer (pg) boots and exits 0",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Reuse the standing default VPC: a public subnet + public IP is
      // required for the task ENI to pull the image from ECR.
      const { subnetIds } = yield* getDefaultVpcNetwork;
      const subnetId = subnetIds[0];
      expect(subnetId).toBeTruthy();

      const { clusterArn, taskDefinitionArn } = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("CjsDualCluster", {
            clusterName: "alchemy-test-cjs-dual",
          });
          const task = yield* CjsDualPackageTask;
          return {
            clusterArn: cluster.clusterArn,
            taskDefinitionArn: task.taskDefinitionArn,
          };
        }).pipe(Effect.provide(CjsDualPackageTaskLive)),
      );
      expect(taskDefinitionArn).toBeTruthy();

      // Launch once, out-of-band; retry the IAM-propagation rejection.
      const started = yield* ecs
        .runTask({
          cluster: clusterArn,
          taskDefinition: taskDefinitionArn!,
          launchType: "FARGATE",
          count: 1,
          startedBy: "alchemy-cjs-dual-test",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: [subnetId!],
              assignPublicIp: "ENABLED",
            },
          },
        })
        .pipe(
          Effect.retry({
            while: (e) =>
              e._tag === "ClientException" &&
              (e.message ?? "").includes("unable to assume the role"),
            schedule: Schedule.spaced("5 seconds"),
            times: 12,
          }),
        );
      expect(started.failures ?? []).toEqual([]);
      const taskArn = started.tasks?.[0]?.taskArn;
      expect(taskArn).toBeTruthy();

      const stopped = yield* ecs
        .describeTasks({ cluster: clusterArn, tasks: [taskArn!] })
        .pipe(
          Effect.flatMap((result) => {
            const task = result.tasks?.[0];
            return task?.lastStatus === "STOPPED"
              ? Effect.succeed(task)
              : Effect.fail(
                  new Error(`task not stopped yet: ${task?.lastStatus}`),
                );
          }),
          Effect.tapError((error) => Effect.logInfo(String(error))),
          Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 50 }),
        );

      // Exit 0 = pg loaded, BoundPool constructed. A mis-resolved bundle
      // dies at module load and exits 1.
      expect(stopped.stoppedReason ?? "").not.toContain("CannotPullContainer");
      expect(stopped.containers?.[0]?.exitCode).toBe(0);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
