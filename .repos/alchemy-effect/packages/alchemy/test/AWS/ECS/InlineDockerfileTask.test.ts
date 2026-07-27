import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import InlineDockerfileTaskLive, {
  InlineDockerfileTask,
} from "./fixtures/inline-dockerfile-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof of the `main` + `Dockerfile.inline` environment composition: the
// fixture's inline content carries a `RUN` that bakes a marker file into an
// image layer, and its bundled `{ run }` program reads the marker back at
// container runtime, exiting non-zero if absent. Exit code 0 proves the
// inline preamble replaced the generated `FROM` (the RUN executed at build
// time) AND the bundle was layered on top of that environment.
//
// Docker + ECR + Fargate placement is minutes of wall clock, so like the
// other Task e2e tests this is gated out of the default sweep: run it
// explicitly with `AWS_TEST_SLOW=1`.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "inline-dockerfile environment bakes RUN artifact into the bundled image",
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
          const cluster = yield* Cluster("InlineDockerfileCluster", {
            clusterName: "alchemy-test-inline-dockerfile",
          });
          const task = yield* InlineDockerfileTask;
          return {
            clusterArn: cluster.clusterArn,
            taskDefinitionArn: task.taskDefinitionArn,
          };
        }).pipe(Effect.provide(InlineDockerfileTaskLive)),
      );

      expect(taskDefinitionArn).toBeTruthy();

      // Launch the one-shot task once, out-of-band.
      const started = yield* ecs.runTask({
        cluster: clusterArn,
        taskDefinition: taskDefinitionArn!,
        launchType: "FARGATE",
        count: 1,
        startedBy: "alchemy-inline-dockerfile-test",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [subnetId!],
            assignPublicIp: "ENABLED",
          },
        },
      });
      expect(started.failures ?? []).toEqual([]);
      const taskArn = started.tasks?.[0]?.taskArn;
      expect(taskArn).toBeTruthy();

      // Wait for the task to stop: image pull + container boot + the
      // one-shot program running to completion (~1-3 minutes cold).
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

      // Exit 0 requires the artifact to have been baked by the inline RUN.
      expect(stopped.stoppedReason ?? "").not.toContain("CannotPullContainer");
      expect(stopped.containers?.[0]?.exitCode).toBe(0);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
