import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  materializeIsolatedProject,
  removeIsolatedProject,
} from "../../IsolatedProject.ts";
import IsolatedProjectJob, {
  MARKER,
  project,
} from "./fixtures/isolated-project-job.ts";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Live proof that the Batch bun bootstrap boots when the job's `main` lives
// in an isolated project (see test/IsolatedProject.ts) — the bundle `cwd`
// resolves none of alchemy's dependencies, so the bootstrap's
// `@distilled.cloud/aws/*` / `@effect/platform-bun` imports must be bundled
// by the virtual-entry plugin rather than found from the project root. With
// them left external bun dies at module load and the job FAILS.
//
// Heavy (Docker build + ECR push + compute environment + Fargate job run),
// so gated behind AWS_TEST_SLOW=1 like the platform e2e.
test.provider.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST)(
  "job bundled from an isolated project runs to SUCCEEDED",
  (stack) =>
    Effect.gen(function* () {
      yield* materializeIsolatedProject(project);
      yield* stack.destroy();

      try {
        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const network = yield* BatchTestNetwork;
            const computeEnvironment = yield* AWS.Batch.ComputeEnvironment(
              "IsolatedProjectCE",
              {
                subnets: network.subnetIds,
                securityGroupIds: network.securityGroupIds,
              },
            );
            const queue = yield* AWS.Batch.JobQueue("IsolatedProjectQueue", {
              computeEnvironments: [computeEnvironment.computeEnvironmentArn],
            });
            const job = yield* IsolatedProjectJob;
            return {
              jobQueueArn: queue.jobQueueArn,
              jobDefinitionArn: job.jobDefinitionArn,
            };
          }),
        );

        const submitted = yield* batch.submitJob({
          jobName: "alchemy-isolated-project-run",
          jobQueue: outputs.jobQueueArn,
          jobDefinition: outputs.jobDefinitionArn!,
        });
        const job = yield* batch.describeJobs({ jobs: [submitted.jobId] }).pipe(
          Effect.map((result) => result.jobs?.[0]),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (j): boolean =>
              j?.status === "SUCCEEDED" || j?.status === "FAILED",
            times: 60,
          }),
        );
        // SUCCEEDED = container exit 0 = the bootstrap booted and ran `run`
        // (the reason is included so a FAILED run shows why).
        expect(`${job?.status}: ${job?.statusReason ?? ""}`).toMatch(
          /^SUCCEEDED:/,
        );

        // The bundled program actually executed: its marker is in the job's
        // log stream (log delivery can lag the state change slightly).
        const logStreamName = job?.container?.logStreamName;
        expect(logStreamName).toBeTruthy();
        const seen = yield* logs
          .getLogEvents({
            logGroupName: "/aws/batch/job",
            logStreamName: logStreamName!,
          })
          .pipe(
            Effect.flatMap((result) =>
              (result.events ?? []).some((e) => e.message?.includes(MARKER))
                ? Effect.succeed(true)
                : Effect.fail(new Error("marker not in log stream yet")),
            ),
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
          );
        expect(seen).toBe(true);

        yield* stack.destroy();
      } finally {
        yield* removeIsolatedProject(project);
      }
    }),
  // Docker build + push (~2-4 min) + CE/queue (~1-2 min) + Fargate job run
  // (~2-4 min) + destroy (~2-3 min).
  { timeout: 1_200_000 },
);
