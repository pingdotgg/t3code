import * as DataSync from "@/AWS/DataSync";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const trustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "datasync.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const s3Policy = (arn: Output.Output<string>) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Action: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
      ],
      Resource: [arn],
    },
    {
      Effect: "Allow" as const,
      Action: [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:GetObjectTagging",
        "s3:ListMultipartUploadParts",
        "s3:PutObject",
        "s3:PutObjectTagging",
      ],
      Resource: [Output.interpolate`${arn}/*`],
    },
  ],
});

export class DataSyncTestFunction extends Lambda.Function<Lambda.Function>()(
  "DataSyncTestFunction",
) {}

export default DataSyncTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // The transfer under test: two S3 locations over empty buckets, so a
    // started execution moves no data and a cancel closes it out quickly.
    const src = yield* S3.Bucket("BindingsSrc", { forceDestroy: true });
    const dst = yield* S3.Bucket("BindingsDst", { forceDestroy: true });
    const role = yield* IAM.Role("BindingsRole", {
      assumeRolePolicyDocument: trustPolicy,
      inlinePolicies: {
        Src: s3Policy(src.bucketArn),
        Dst: s3Policy(dst.bucketArn),
      },
    });
    const source = yield* DataSync.LocationS3("BindingsSrcLoc", {
      s3BucketArn: src.bucketArn,
      bucketAccessRoleArn: role.roleArn,
    });
    const dest = yield* DataSync.LocationS3("BindingsDstLoc", {
      s3BucketArn: dst.bucketArn,
      bucketAccessRoleArn: role.roleArn,
    });
    const task = yield* DataSync.Task("BindingsTask", {
      sourceLocationArn: source.locationArn,
      destinationLocationArn: dest.locationArn,
    });

    // Event source: subscribe the host to DataSync task/execution state
    // changes. The deploy proves the EventBridge rule + invoke permission
    // wiring.
    yield* DataSync.consumeTaskEvents(
      { kinds: ["task-state-change", "task-execution-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`datasync ${event["detail-type"]}: ${event.detail.State}`),
        ),
    );

    const startTaskExecution = yield* DataSync.StartTaskExecution(task);
    const describeTask = yield* DataSync.DescribeTask(task);
    const listTaskExecutions = yield* DataSync.ListTaskExecutions(task);
    const describeTaskExecution = yield* DataSync.DescribeTaskExecution(task);
    const cancelTaskExecution = yield* DataSync.CancelTaskExecution(task);
    const updateTaskExecution = yield* DataSync.UpdateTaskExecution(task);

    const bound = {
      startTaskExecution,
      describeTask,
      listTaskExecutions,
      describeTaskExecution,
      cancelTaskExecution,
      updateTaskExecution,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn");

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Task-scoped read: the TaskArn is injected from the binding.
        if (request.method === "GET" && pathname === "/task") {
          const detail = yield* describeTask();
          return yield* HttpServerResponse.json({
            taskArn: detail.TaskArn,
            status: detail.Status,
            name: detail.Name,
          });
        }

        // Start a run. A freshly-attached IAM role can transiently fail
        // DataSync's location access test (typed LocationAccessTestFailed);
        // retry briefly in-route, then report the typed tag so the test can
        // re-poll instead of treating it as a hard failure.
        if (request.method === "POST" && pathname === "/start") {
          const started = yield* startTaskExecution().pipe(
            Effect.retry({
              while: (e): boolean => e._tag === "LocationAccessTestFailed",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(5),
              ]),
            }),
            Effect.result,
          );
          return yield* HttpServerResponse.json(
            started._tag === "Success"
              ? { ok: true, executionArn: started.success.TaskExecutionArn }
              : { ok: false, tag: started.failure._tag },
          );
        }

        // List the task's runs: the TaskArn is injected from the binding.
        if (request.method === "GET" && pathname === "/executions") {
          const { TaskExecutions } = yield* listTaskExecutions();
          return yield* HttpServerResponse.json({
            arns: (TaskExecutions ?? []).map((e) => e.TaskExecutionArn),
          });
        }

        if (arn === null) {
          return yield* HttpServerResponse.json(
            { error: "missing arn" },
            { status: 400 },
          );
        }

        // Execution-addressed reads/writes: the execution ARN comes from
        // /start; IAM was granted on the bound task's execution pattern.
        if (request.method === "GET" && pathname === "/execution") {
          const execution = yield* describeTaskExecution({
            TaskExecutionArn: arn,
          });
          return yield* HttpServerResponse.json({
            status: execution.Status,
            bytesTransferred: execution.BytesTransferred,
          });
        }

        // Throttling is only valid while the run is launching/preparing/
        // transferring/verifying — report the typed rejection instead of
        // failing so the test can assert the binding round-trips.
        if (request.method === "POST" && pathname === "/throttle") {
          const updated = yield* updateTaskExecution({
            TaskExecutionArn: arn,
            Options: { BytesPerSecond: 1024 * 1024 },
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            updated._tag === "Success"
              ? { updated: true }
              : { updated: false, tag: updated.failure._tag },
          );
        }

        if (request.method === "POST" && pathname === "/cancel") {
          const cancelled = yield* cancelTaskExecution({
            TaskExecutionArn: arn,
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json(
            cancelled._tag === "Success"
              ? { cancelled: true }
              : { cancelled: false, tag: cancelled.failure._tag },
          );
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
        DataSync.StartTaskExecutionHttp,
        DataSync.DescribeTaskHttp,
        DataSync.ListTaskExecutionsHttp,
        DataSync.DescribeTaskExecutionHttp,
        DataSync.CancelTaskExecutionHttp,
        DataSync.UpdateTaskExecutionHttp,
      ),
    ),
  ),
);
