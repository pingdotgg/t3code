import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Layer from "effect/Layer";
import DynamoDBStreamFunctionLive, {
  DynamoDBStreamFunction,
  TableAndQueue,
  TableAndQueueLive,
} from "./stream-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.skipIf(!!process.env.FAST).sequential("AWS.DynamoDB.Stream", () => {
  test.provider(
    "processes real DynamoDB stream records through Lambda",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "DynamoDB Stream test: destroying previous resources",
        );
        yield* stack.destroy();

        yield* Effect.logInfo("DynamoDB Stream test: deploying stream fixture");
        const { table, queue, streamFunction } = yield* stack.deploy(
          Effect.gen(function* () {
            const { table, queue } = yield* TableAndQueue;

            const func = yield* DynamoDBStreamFunction;

            return { table, queue, streamFunction: func };
          }).pipe(
            Effect.provide(
              Layer.mergeAll(DynamoDBStreamFunctionLive, TableAndQueueLive),
            ),
          ),
        );

        const streamState = yield* waitForTableStreamSpecification(
          table.tableName,
          {
            StreamEnabled: true,
            StreamViewType: "NEW_AND_OLD_IMAGES",
          },
        );
        expect(streamState.Table?.StreamSpecification).toEqual({
          StreamEnabled: true,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        });
        expect(streamState.Table?.LatestStreamArn).toBeDefined();

        yield* waitForEventSourceMappingEnabled(
          streamFunction.functionName,
          streamState.Table?.LatestStreamArn!,
        );

        yield* Effect.logInfo(
          `DynamoDB Stream test: writing item into ${table.tableName}`,
        );
        yield* DynamoDB.putItem({
          TableName: table.tableName,
          Item: {
            pk: { S: "stream#1" },
            sk: { S: "item#1" },
            data: { S: "payload" },
          },
        });

        const message = yield* waitForQueueMessage(queue.queueUrl);
        const body = JSON.parse(message.Body!);

        expect(body.eventName).toEqual("INSERT");
        expect(body.keys.pk.S).toEqual("stream#1");
        expect(body.keys.sk.S).toEqual("item#1");
        expect(body.newImage.data.S).toEqual("payload");
        expect(body.oldImage).toBeUndefined();

        yield* Effect.logInfo("DynamoDB Stream test: destroying fixture");
        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
      }),
    // Must stay UNDER the factory's 300s hard-kill wall: a vitest timeout
    // interrupts the fiber and the `test.provider` ensuring-destroy reclaims
    // every deployed resource, whereas an external SIGKILL leaks the whole
    // fixture stack (Table + Queue + Function + Permission + ESM) with no
    // way to reclaim it (scratch state is in-memory). Typical green run is
    // ~105s, so 230s leaves interruption + destroy comfortably inside 300s.
    { timeout: 230_000 },
  );
});

// Out-of-band proof that the trailing destroy deleted the fixture table.
const assertTableIsDeleted = Effect.fn(function* (tableName: string) {
  yield* Effect.logInfo(
    `DynamoDB Stream test: waiting for deletion of ${tableName}`,
  );
  yield* DynamoDB.describeTable({
    TableName: tableName,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new TableStillExists())),
    Effect.retry({
      while: (e) => e._tag === "TableStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

const waitForEventSourceMappingEnabled = Effect.fn(function* (
  functionName: string,
  eventSourceArn: string,
) {
  yield* Effect.logInfo(
    `DynamoDB Stream test: waiting for Lambda event source mapping on ${functionName}`,
  );

  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      if (!mapping || mapping.State !== "Enabled") {
        return Effect.logInfo(
          `DynamoDB Stream test: event source mapping not ready yet. state=${mapping?.State ?? "missing"}`,
        ).pipe(Effect.andThen(Effect.fail(new EventSourceMappingNotReady())));
      }
      return Effect.logInfo(
        `DynamoDB Stream test: event source mapping ready (${mapping.UUID})`,
      ).pipe(Effect.andThen(Effect.succeed(mapping)));
    }),
    Effect.retry({
      while: (error) => error._tag === "EventSourceMappingNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
});

const waitForTableStreamSpecification = Effect.fn(function* (
  tableName: string,
  expected: DynamoDB.StreamSpecification,
) {
  yield* Effect.logInfo(
    `DynamoDB Stream test: waiting for stream configuration on ${tableName}`,
  );

  return yield* DynamoDB.describeTable({
    TableName: tableName,
  }).pipe(
    Effect.flatMap((result) => {
      const actual = result.Table?.StreamSpecification;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        return Effect.logInfo(
          `DynamoDB Stream test: stream configuration not ready yet. actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
        ).pipe(
          Effect.andThen(Effect.fail(new TableStreamConfigurationNotReady())),
        );
      }
      return Effect.logInfo(
        `DynamoDB Stream test: stream configuration ready on ${tableName}`,
      ).pipe(Effect.andThen(Effect.succeed(result)));
    }),
    Effect.retry({
      while: (error) => error._tag === "TableStreamConfigurationNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
});

const waitForQueueMessage = Effect.fn(function* (queueUrl: string) {
  yield* Effect.logInfo(
    `DynamoDB Stream test: waiting for stream output message on ${queueUrl}`,
  );

  // Even after the EventSourceMapping reports `Enabled`, AWS needs a cold-
  // start window (typically 30–90s for the first record) before the Lambda
  // is reliably invoked from a freshly-provisioned DynamoDB Stream shard.
  // Use SQS long-polling (WaitTimeSeconds=20) and budget ~3 minutes so this
  // is robust on first-deploy runs without slowing down the happy path.
  return yield* SQS.receiveMessage({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 20,
  }).pipe(
    Effect.flatMap((result) => {
      const message = result.Messages?.[0];
      if (!message?.Body) {
        return Effect.logInfo(
          "DynamoDB Stream test: stream output queue is still empty",
        ).pipe(Effect.andThen(Effect.fail(new StreamMessageNotReady())));
      }
      return Effect.logInfo(
        `DynamoDB Stream test: received stream output message ${message.MessageId}`,
      ).pipe(Effect.andThen(Effect.succeed(message)));
    }),
    Effect.retry({
      while: (error) => error._tag === "StreamMessageNotReady",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(72),
      ]),
    }),
  );
});

class TableStillExists extends Data.TaggedError("TableStillExists") {}

class EventSourceMappingNotReady extends Data.TaggedError(
  "EventSourceMappingNotReady",
) {}

class TableStreamConfigurationNotReady extends Data.TaggedError(
  "TableStreamConfigurationNotReady",
) {}

class StreamMessageNotReady extends Data.TaggedError("StreamMessageNotReady") {}
