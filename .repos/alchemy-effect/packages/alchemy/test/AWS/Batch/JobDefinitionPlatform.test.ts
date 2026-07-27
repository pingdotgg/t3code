import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as batch from "@distilled.cloud/aws/batch";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import NightlyJob, { MARKER } from "./fixtures/nightly-job.ts";
import { BatchTestNetwork } from "./TestNetwork.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Full end-to-end for the Effect-native `Batch.JobDefinition` form: bundle
// the inline run-to-completion Effect, build + push the container image to
// the managed ECR repository (Docker build, linux/amd64), provision the
// job/execution IAM roles, register the job definition — then submit a job
// against it and prove the Effect actually ran inside Batch: the job lands
// in SUCCEEDED (container exit 0) and the marker appears in its
// `/aws/batch/job` log stream.
//
// It is heavy (Docker build + ECR push + Fargate provisioning of the job,
// several minutes end to end), so it is gated behind AWS_TEST_SLOW=1 and
// always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "deploys an Effect-native Batch job definition and runs it to SUCCEEDED",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* BatchTestNetwork;
          const computeEnvironment = yield* AWS.Batch.ComputeEnvironment(
            "PlatformCE",
            {
              subnets: network.subnetIds,
              securityGroupIds: network.securityGroupIds,
            },
          );
          const queue = yield* AWS.Batch.JobQueue("PlatformQueue", {
            computeEnvironments: [computeEnvironment.computeEnvironmentArn],
          });
          const job = yield* NightlyJob;
          return {
            jobQueueArn: queue.jobQueueArn,
            jobDefinitionName: job.jobDefinitionName,
            jobDefinitionArn: job.jobDefinitionArn,
            imageUri: job.imageUri,
            repositoryName: job.repositoryName,
            repositoryUri: job.repositoryUri,
            codeHash: job.codeHash,
            jobRoleArn: job.jobRoleArn,
            jobRoleName: job.jobRoleName,
            executionRoleName: job.executionRoleName,
          };
        }),
      );

      // Effect-native attributes: managed repo, roles, and image.
      expect(outputs.jobDefinitionName).toBe("alchemy-test-batch-platform-e2e");
      expect(outputs.repositoryUri).toBeTruthy();
      expect(outputs.imageUri).toBe(
        `${outputs.repositoryUri}:${outputs.codeHash}`,
      );
      expect(outputs.jobRoleArn).toContain(":role/");

      // Out-of-band verification via distilled: the registered revision runs
      // the built image with the managed roles.
      const described = yield* batch.describeJobDefinitions({
        jobDefinitions: [outputs.jobDefinitionArn!],
      });
      const container = described.jobDefinitions?.[0]?.containerProperties;
      expect(container?.image).toBe(outputs.imageUri);
      expect(container?.jobRoleArn).toBe(outputs.jobRoleArn);

      // Submit a job against the platform definition and wait for the
      // run-to-completion Effect to finish (SUCCEEDED = container exit 0).
      const submitted = yield* batch.submitJob({
        jobName: "alchemy-e2e-platform-run",
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
      expect(job?.status).toBe("SUCCEEDED");

      // The bundled Effect actually executed: its marker is in the job's
      // log stream (log delivery can lag the state change slightly).
      const logStreamName = job?.container?.logStreamName;
      expect(logStreamName).toBeTruthy();
      const events = yield* logs
        .getLogEvents({
          logGroupName: "/aws/batch/job",
          logStreamName: logStreamName!,
        })
        .pipe(
          Effect.flatMap((result) =>
            (result.events ?? []).some((e) => e.message?.includes(MARKER))
              ? Effect.succeed(result.events ?? [])
              : Effect.fail(new Error("marker not in log stream yet")),
          ),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
      expect(events.some((e) => e.message?.includes(MARKER))).toBe(true);

      // Destroy — and verify zero leftovers: job definition revisions, the
      // managed repository, and both managed roles.
      const {
        jobDefinitionName,
        repositoryName,
        jobRoleName,
        executionRoleName,
      } = outputs;
      yield* stack.destroy();

      const revisions = yield* batch.describeJobDefinitions({
        jobDefinitionName,
        status: "ACTIVE",
      });
      expect(revisions.jobDefinitions ?? []).toHaveLength(0);

      const repoError = yield* Effect.flip(
        ecr.describeRepositories({ repositoryNames: [repositoryName!] }),
      );
      expect(repoError._tag).toBe("RepositoryNotFoundException");

      for (const roleName of [jobRoleName!, executionRoleName!]) {
        const roleError = yield* Effect.flip(
          iam.getRole({ RoleName: roleName }),
        );
        expect(roleError._tag).toBe("NoSuchEntityException");
      }
    }),
  // Docker build + push (~2-4 min) + CE/queue (~1-2 min) + Fargate job run
  // (~2-4 min) + destroy (~2-3 min).
  { timeout: 1_200_000 },
);
