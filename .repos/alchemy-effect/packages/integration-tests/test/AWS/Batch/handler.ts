import * as Batch from "@alchemy.run/aws/Batch";
import * as IAM from "@alchemy.run/aws/IAM";
import * as Lambda from "@alchemy.run/aws/Lambda";
import type * as batch from "@distilled.cloud/aws/batch";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import path from "pathe";
import { BatchTestNetwork } from "./TestNetwork.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class BatchTestFunction extends Lambda.Function<Lambda.Function>()("BatchTestFunction") {}

export default BatchTestFunction.make(
  {
    main,
    functionUrl: true,
    // submit/describe fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The default run uses a managed Fargate CE so the SUCCEEDED round-trip in
    // Bindings.test.ts can actually run a job. Under --fast (FAST=1) the
    // capability tests only need jobs to reach RUNNABLE, so an unmanaged CE
    // with no VPC resources is enough. Bindings.test.ts gates SUCCEEDED on the
    // same predicate: an unmanaged CE has no instances, so jobs never leave RUNNABLE.
    const fargate = !process.env.FAST;
    const unmanagedServiceRole = fargate
      ? undefined
      : yield* IAM.Role("BatchServiceRole", {
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "batch.amazonaws.com" },
                Action: ["sts:AssumeRole"],
              },
            ],
          },
          managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"],
        });

    const computeEnvironment = fargate
      ? yield* Effect.gen(function* () {
          const network = yield* BatchTestNetwork;
          return yield* Batch.ComputeEnvironment("TestCE", {
            subnets: network.subnetIds,
            securityGroupIds: network.securityGroupIds,
          });
        })
      : yield* Batch.ComputeEnvironment("TestCE", {
          managementType: "UNMANAGED",
          unmanagedvCpus: 4,
          serviceRole: unmanagedServiceRole!.roleArn,
        });
    const queue = yield* Batch.JobQueue("TestQueue", {
      computeEnvironments: [computeEnvironment.computeEnvironmentArn],
    });
    const executionRole = yield* IAM.Role("BatchExecutionRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
    });
    const jobDefinition = yield* Batch.JobDefinition("EchoJob", {
      image: "public.ecr.aws/docker/library/busybox:latest",
      command: ["echo", "hello-from-batch"],
      executionRoleArn: executionRole.roleArn,
      platformCapabilities: fargate ? ["FARGATE"] : ["EC2"],
      vcpus: fargate ? 0.25 : 1,
      timeout: Duration.minutes(5),
    });

    const submitJob = yield* Batch.SubmitJob(queue, jobDefinition);
    const describeJobs = yield* Batch.DescribeJobs(queue);
    const terminateJob = yield* Batch.TerminateJob(queue);
    const cancelJob = yield* Batch.CancelJob(queue);
    const listJobs = yield* Batch.ListJobs(queue);
    const getJobQueueSnapshot = yield* Batch.GetJobQueueSnapshot(queue);

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.batch) targeting this Function. Runtime firing rides on real job
    // submissions from the suite; the test verifies the rule deploys.
    yield* Batch.consumeJobEvents({ kinds: ["job-state"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(`batch job event: ${event.detail.jobId} -> ${event.detail.status}`),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/submit") {
          const body = (yield* request.json) as unknown as {
            jobName: string;
          };
          const result = yield* submitJob({ jobName: body.jobName });
          return yield* HttpServerResponse.json({
            jobId: result.jobId,
            jobName: result.jobName,
            jobArn: result.jobArn,
          });
        }

        if (request.method === "GET" && pathname === "/status") {
          const jobId = url.searchParams.get("jobId")!;
          const result = yield* describeJobs({ jobs: [jobId] });
          const job = result.jobs?.[0];
          return yield* HttpServerResponse.json({
            status: job?.status,
            statusReason: job?.statusReason,
            jobQueue: job?.jobQueue,
          });
        }

        if (request.method === "POST" && pathname === "/terminate") {
          const body = (yield* request.json) as unknown as {
            jobId: string;
            reason: string;
          };
          yield* terminateJob({ jobId: body.jobId, reason: body.reason });
          return yield* HttpServerResponse.json({ terminated: true });
        }

        if (request.method === "POST" && pathname === "/cancel") {
          const body = (yield* request.json) as unknown as {
            jobId: string;
            reason: string;
          };
          yield* cancelJob({ jobId: body.jobId, reason: body.reason });
          return yield* HttpServerResponse.json({ cancelled: true });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const jobStatus = url.searchParams.get("jobStatus") ?? undefined;
          const result = yield* listJobs(
            jobStatus ? { jobStatus: jobStatus as batch.JobStatus } : {},
          );
          return yield* HttpServerResponse.json({
            jobs: (result.jobSummaryList ?? []).map((job) => ({
              jobId: job.jobId,
              jobName: job.jobName,
              status: job.status,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/snapshot") {
          const result = yield* getJobQueueSnapshot();
          return yield* HttpServerResponse.json({
            jobs: (result.frontOfQueue?.jobs ?? []).map((job) => job.jobArn),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Batch.SubmitJobHttp,
        Batch.DescribeJobsHttp,
        Batch.TerminateJobHttp,
        Batch.CancelJobHttp,
        Batch.ListJobsHttp,
        Batch.GetJobQueueSnapshotHttp,
      ),
    ),
  ),
);
