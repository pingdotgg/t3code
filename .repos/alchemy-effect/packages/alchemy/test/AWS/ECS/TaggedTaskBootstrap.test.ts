import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import TaggedOneShotTaskLive, {
  TaggedOneShotTask,
} from "./fixtures/tagged-oneshot-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the TAGGED platform form (`class X extends Task<X>()(id) {}`
// + `export default X.make(props, impl)`) boots on ECS: the bundled entry's
// default export is a LAYER, which the bun bootstrap must fold through
// `makeEntrypointLayer` (the inline-effect class form exports an Effect and is
// covered by the Task e2e smoke test). We deploy the fixture (Docker build +
// ECR push), launch it once on Fargate via `ecs.runTask`, and assert the task
// runs to completion with container exit code 0 — a bootstrap crash ("Not a
// valid effect") exits non-zero and fails the assertion.
//
// Docker + ECR + Fargate placement is minutes of wall clock, so like the Task
// e2e smoke test this is gated out of the default sweep: run it explicitly
// with `AWS_TEST_SLOW=1`.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "tagged-form one-shot task boots and exits 0",
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
          const cluster = yield* Cluster("TaggedOneShotCluster", {
            clusterName: "alchemy-test-tagged-oneshot",
          });
          const task = yield* TaggedOneShotTask;
          return {
            clusterArn: cluster.clusterArn,
            taskDefinitionArn: task.taskDefinitionArn,
          };
        }).pipe(Effect.provide(TaggedOneShotTaskLive)),
      );

      expect(taskDefinitionArn).toBeTruthy();

      // Launch the one-shot task once, out-of-band.
      const started = yield* ecs.runTask({
        cluster: clusterArn,
        taskDefinition: taskDefinitionArn!,
        launchType: "FARGATE",
        count: 1,
        startedBy: "alchemy-tagged-bootstrap-test",
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

      // Wait for the task to stop: image pull + container boot + the one-shot
      // program running to completion (~1-3 minutes for a cold Fargate task).
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

      // Exit code 0 proves the Layer-form entrypoint booted, ran `{ run }`,
      // and exited cleanly. A bootstrap crash exits 1 (and a task that never
      // starts reports a stoppedReason instead of an exit code).
      expect(stopped.stoppedReason ?? "").not.toContain("CannotPullContainer");
      expect(stopped.containers?.[0]?.exitCode).toBe(0);

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
