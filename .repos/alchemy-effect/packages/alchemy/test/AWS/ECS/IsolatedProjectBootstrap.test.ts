import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/ECS/Cluster.ts";
import * as Test from "@/Test/Alchemy";
import * as ecs from "@distilled.cloud/aws/ecs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import { getDefaultVpcNetwork } from "../DefaultVpc.ts";
import IsolatedProjectTaskLive, {
  IsolatedProjectTask,
  project,
} from "./fixtures/isolated-project-task.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the generated bun bootstrap boots when the task's `main`
// lives in a project that cannot resolve alchemy's dependencies itself — a
// consumer installed with bun's isolated linker (or pnpm), where
// `@distilled.cloud/aws`, `@effect/platform-bun`, … sit beside `alchemy`
// rather than in the project's own `node_modules`.
//
// The fixture's `main` points at an isolated project OUTSIDE the repository
// (see test/IsolatedProject.ts), so the bundle `cwd` resolves nothing bare.
// We deploy it (Docker build + ECR push), launch it once on Fargate, and
// assert the task runs to completion with container exit code 0. With the
// bootstrap's imports left external the container dies at boot with
// `Cannot find module …` (exit code 1).
//
// Docker + ECR + Fargate placement is minutes of wall clock, so like the Task
// e2e smoke test this is gated out of the default sweep: run it explicitly
// with `AWS_TEST_SLOW=1`.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "task bundled from an isolated project boots and exits 0",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        // Reuse the standing default VPC: a public subnet + public IP is
        // required for the task ENI to pull the image from ECR.
        const { subnetIds } = yield* getDefaultVpcNetwork;
        const subnetId = subnetIds[0];
        expect(subnetId).toBeTruthy();

        const { clusterArn, taskDefinitionArn } = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* Cluster("IsolatedProjectCluster", {
              clusterName: "alchemy-test-isolated-project",
            });
            const task = yield* IsolatedProjectTask;
            return {
              clusterArn: cluster.clusterArn,
              taskDefinitionArn: task.taskDefinitionArn,
            };
          }).pipe(Effect.provide(IsolatedProjectTaskLive)),
        );

        expect(taskDefinitionArn).toBeTruthy();

        // Launch the one-shot task once, out-of-band. The task/execution
        // roles were created seconds ago: ECS rejects `runTask` with
        // "unable to assume the role" until IAM propagates, so retry that
        // one typed error (bounded).
        const started = yield* ecs
          .runTask({
            cluster: clusterArn,
            taskDefinition: taskDefinitionArn!,
            launchType: "FARGATE",
            count: 1,
            startedBy: "alchemy-isolated-project-test",
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
            Effect.retry({
              schedule: Schedule.spaced("6 seconds"),
              times: 50,
            }),
          );

        // Exit code 0 proves the bootstrap's own imports were bundled and the
        // program ran `{ run }` to completion; externalised imports crash bun
        // at module load and the container exits 1.
        expect(stopped.stoppedReason ?? "").not.toContain(
          "CannotPullContainer",
        );
        expect(stopped.containers?.[0]?.exitCode).toBe(0);

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  { timeout: 900_000 },
);
