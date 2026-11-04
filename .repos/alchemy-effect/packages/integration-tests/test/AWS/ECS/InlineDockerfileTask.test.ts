import * as AWS from "@alchemy.run/aws";
import { Cluster } from "@alchemy.run/aws/ECS/Cluster";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import BuildSecretsTask from "./fixtures/buildsecrets-task.ts";
import InlineDockerfileTaskLive, {
  InlineDockerfileTask,
} from "./fixtures/inline-dockerfile-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Run a one-shot task once, out-of-band, on the standing default VPC (a
 * public subnet + public IP lets the task ENI pull from ECR), and wait for
 * it to stop.
 */
const runToCompletion = Effect.fn(function* (clusterArn: string, taskDefinitionArn: string) {
  const { subnetIds } = yield* getDefaultVpcNetwork;
  const subnetId = subnetIds[0];
  expect(subnetId).toBeTruthy();

  // The task/execution roles were created seconds ago: ECS rejects `runTask`
  // with "unable to assume the role" until IAM propagates, so retry that one
  // typed error (bounded).
  const started = yield* ecs
    .runTask({
      cluster: clusterArn,
      taskDefinition: taskDefinitionArn,
      launchType: "FARGATE",
      count: 1,
      startedBy: "alchemy-inline-dockerfile-test",
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
          e._tag === "ClientException" && (e.message ?? "").includes("unable to assume the role"),
        schedule: Schedule.spaced("5 seconds"),
        times: 12,
      }),
    );
  expect(started.failures ?? []).toEqual([]);
  const taskArn = started.tasks?.[0]?.taskArn;
  expect(taskArn).toBeTruthy();

  // Wait for the task to stop: image pull + container boot + the one-shot
  // program running to completion (~1-3 minutes cold).
  const stopped = yield* ecs.describeTasks({ cluster: clusterArn, tasks: [taskArn!] }).pipe(
    Effect.flatMap((result) => {
      const task = result.tasks?.[0];
      return task?.lastStatus === "STOPPED"
        ? Effect.succeed(task)
        : Effect.fail(new Error(`task not stopped yet: ${task?.lastStatus}`));
    }),
    Effect.tapError((error) => Effect.logInfo(String(error))),
    Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 50 }),
  );
  expect(stopped.stoppedReason ?? "").not.toContain("CannotPullContainer");
  return stopped;
});

const tags = [
  "provider:aws",
  "provider:aws:ec2",
  "provider:aws:ecs",
  "provider:docker",
  "provider:docker:dockerfile",
  "live",
];

// Live proof of the `main` + `Dockerfile.inline` environment composition: the
// fixture's inline content carries a `RUN` that bakes a marker file into an
// image layer, and its bundled `{ run }` program reads the marker back at
// container runtime, exiting non-zero if absent. Exit code 0 proves the
// inline preamble replaced the generated `FROM` (the RUN executed at build
// time) AND the bundle was layered on top of that environment.
//
// Docker + ECR + Fargate placement is ~1 minute of wall clock, so it is
// skipped under --fast like the Task e2e smoke test.
test.provider.skipIf(!!process.env.FAST)(
  "inline-dockerfile environment bakes RUN artifact into the bundled image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

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

      // Exit 0 requires the artifact to have been baked by the inline RUN.
      const stopped = yield* runToCompletion(clusterArn, taskDefinitionArn!);
      expect(stopped.containers?.[0]?.exitCode).toBe(0);

      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);

// A `context` Task built with a build arg and a BuildKit secret. Its command
// exits 0 only when the build saw the arg and the mounted secret.
test.provider.skipIf(!!process.env.FAST)(
  "a Dockerfile task builds with build args and BuildKit secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { clusterArn, taskDefinitionArn } = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* Cluster("BuildSecretsCluster");
          const task = yield* BuildSecretsTask;
          return {
            clusterArn: cluster.clusterArn,
            taskDefinitionArn: task.taskDefinitionArn,
          };
        }),
      );
      expect(taskDefinitionArn).toBeTruthy();

      const stopped = yield* runToCompletion(clusterArn, taskDefinitionArn!);
      expect(stopped.containers?.[0]?.exitCode).toBe(0);

      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);
