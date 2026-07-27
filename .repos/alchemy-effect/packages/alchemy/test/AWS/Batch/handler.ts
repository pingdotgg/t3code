import * as Batch from "@/AWS/Batch";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import type * as batch from "@distilled.cloud/aws/batch";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { BatchTestNetwork } from "./TestNetwork.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class BatchTestFunction extends Lambda.Function<Lambda.Function>()(
  "BatchTestFunction",
) {}

export default BatchTestFunction.make(
  {
    main,
    url: true,
    // submit/describe fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const unmanagedServiceRole = process.env.AWS_TEST_SLOW
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
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole",
          ],
        });

    // Fast capability tests only need jobs to reach RUNNABLE, so use an
    // unmanaged CE without VPC resources. The slow SUCCEEDED round-trip keeps
    // the managed Fargate path and its stack-owned network.
    const computeEnvironment = process.env.AWS_TEST_SLOW
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
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
      ],
    });
    const jobDefinition = yield* Batch.JobDefinition("EchoJob", {
      image: "public.ecr.aws/docker/library/busybox:latest",
      command: ["echo", "hello-from-batch"],
      executionRoleArn: executionRole.roleArn,
      platformCapabilities: process.env.AWS_TEST_SLOW ? ["FARGATE"] : ["EC2"],
      vcpus: process.env.AWS_TEST_SLOW ? 0.25 : 1,
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
        Effect.log(
          `batch job event: ${event.detail.jobId} -> ${event.detail.status}`,
        ),
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
