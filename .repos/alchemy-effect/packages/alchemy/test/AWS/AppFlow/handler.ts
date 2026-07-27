import * as AWS from "@/AWS";
import type { PolicyStatement } from "@/AWS/IAM";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Deterministic names shared by the fixture and the test (the test seeds the
// source prefix out-of-band and filters flow events by name).
export const FLOW_BUCKET = "alchemy-test-appflow-bindings";
export const FLOW_NAME = "alchemy-test-appflow-bindings-flow";
const BUCKET_ARN = `arn:aws:s3:::${FLOW_BUCKET}`;

// AppFlow's S3 connector requires the bucket policy to authorize the service
// principal for reads (source) and writes (destination).
const appflowBucketPolicy: PolicyStatement[] = [
  {
    Effect: "Allow",
    Principal: { Service: "appflow.amazonaws.com" },
    Action: ["s3:GetObject", "s3:ListBucket"],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
  {
    Effect: "Allow",
    Principal: { Service: "appflow.amazonaws.com" },
    Action: [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:ListBucketMultipartUploads",
      "s3:GetBucketAcl",
      "s3:PutObjectAcl",
    ],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
];

/**
 * The flow's source/destination bucket, exported on its own so the test can
 * deploy it FIRST and seed `input/` before the flow is created — AppFlow
 * validates the source prefix is non-empty at `CreateFlow` time.
 */
export const FlowBucket = Effect.gen(function* () {
  return yield* AWS.S3.Bucket("FlowBucket", {
    bucketName: FLOW_BUCKET,
    forceDestroy: true,
    policy: appflowBucketPolicy,
  });
});

export class AppFlowApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "AppFlowApiFunction",
) {}

/**
 * Shared infrastructure for the AppFlow bindings fixture:
 * - the S3-to-S3 on-demand flow the bindings are exercised against
 * - an SQS sink queue where the `flowEvents` consume loop forwards AppFlow
 *   run reports so the test can observe them out-of-band.
 */
export class FlowFixture extends Context.Service<
  FlowFixture,
  {
    bucket: AWS.S3.Bucket;
    flow: AWS.AppFlow.Flow;
    eventsQueue: AWS.SQS.Queue;
  }
>()("AppFlowFlowFixture") {}

export const FlowFixtureLive = Layer.effect(
  FlowFixture,
  Effect.gen(function* () {
    const bucket = yield* FlowBucket;
    const flow = yield* AWS.AppFlow.Flow("BindingsFlow", {
      flowName: FLOW_NAME,
      triggerConfig: { triggerType: "OnDemand" },
      sourceFlowConfig: {
        connectorType: "S3",
        sourceConnectorProperties: {
          S3: { bucketName: bucket.bucketName, bucketPrefix: "input" },
        },
      },
      destinationFlowConfigList: [
        {
          connectorType: "S3",
          destinationConnectorProperties: {
            S3: { bucketName: bucket.bucketName, bucketPrefix: "output" },
          },
        },
      ],
      tasks: [
        {
          taskType: "Map_all",
          sourceFields: [],
          connectorOperator: { S3: "NO_OP" },
          taskProperties: {},
        },
      ],
    });
    const eventsQueue = yield* AWS.SQS.Queue("FlowEventsSink");
    return { bucket, flow, eventsQueue };
  }),
);

export const AppFlowApiFunctionLive = AppFlowApiFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { flow, eventsQueue } = yield* FlowFixture;

    const startFlow = yield* AWS.AppFlow.StartFlow(flow);
    const stopFlow = yield* AWS.AppFlow.StopFlow(flow);
    const cancelFlowExecutions = yield* AWS.AppFlow.CancelFlowExecutions(flow);
    const describeFlowExecutionRecords =
      yield* AWS.AppFlow.DescribeFlowExecutionRecords(flow);
    const eventsSink = yield* AWS.SQS.QueueSink(eventsQueue);
    const flowEventPattern = AWS.AppFlow.flowEvents({
      flowNames: [FLOW_NAME],
    });

    // Forward this flow's AppFlow run reports into the sink queue so the test
    // can observe them out-of-band via `sqs.receiveMessage`. Native AppFlow
    // reports use the reserved `aws.appflow` source and are best-effort. Keep
    // that production pattern and add a custom source solely so the test can
    // publish a deterministic readiness/report probe through PutEvents.
    yield* AWS.EventBridge.consumeBusEvents(
      {
        ...flowEventPattern,
        source: [...flowEventPattern.source, "alchemy.test.appflow"],
      },
      (events: Stream.Stream<AWS.EventBridge.EventRecord>) =>
        events.pipe(
          Stream.map((event) => ({
            MessageBody: JSON.stringify({
              detailType: event["detail-type"],
              detail: event.detail,
            }),
          })),
          Stream.run(eventsSink),
          Effect.orDie,
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/start") {
          const result = yield* startFlow();
          return yield* HttpServerResponse.json({
            executionId: result.executionId,
            flowStatus: result.flowStatus,
            flowArn: result.flowArn,
          });
        }

        // OnDemand flows cannot be stopped; AppFlow answers with a typed
        // UnsupportedOperationException — surfaced as `{ ok: false, error }`
        // so the test can assert the exact tag.
        if (request.method === "POST" && pathname === "/stop") {
          const response = yield* stopFlow().pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "POST" && pathname === "/cancel") {
          const body = (yield* request.json) as {
            executionIds?: string[];
          };
          const response = yield* cancelFlowExecutions({
            executionIds: body.executionIds,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({
                ok: false as const,
                error: error._tag,
              }),
              onSuccess: (value) => ({
                ok: true as const,
                invalidExecutions: value.invalidExecutions ?? [],
              }),
            }),
          );
          return yield* HttpServerResponse.json(response);
        }

        if (request.method === "GET" && pathname === "/executions") {
          const result = yield* describeFlowExecutionRecords();
          return yield* HttpServerResponse.json({
            flowExecutions: (result.flowExecutions ?? []).map((record) => ({
              executionId: record.executionId,
              executionStatus: record.executionStatus,
            })),
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
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.EventSource,
          AWS.AppFlow.StartFlowHttp,
          AWS.AppFlow.StopFlowHttp,
          AWS.AppFlow.CancelFlowExecutionsHttp,
          AWS.AppFlow.DescribeFlowExecutionRecordsHttp,
          AWS.SQS.QueueSinkHttp,
          FlowFixtureLive,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp),
      ),
    ),
  ),
  // Re-merge so the deploying test can `yield* FlowFixture` and expose the
  // flow name / queue url as deploy outputs. Reusing the same reference keeps
  // it a single shared flow/queue.
).pipe(Layer.provideMerge(FlowFixtureLive));

export default AppFlowApiFunctionLive;
