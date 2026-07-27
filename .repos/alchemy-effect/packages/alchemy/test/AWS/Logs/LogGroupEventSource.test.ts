import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LogGroupEventSourceFunctionLive, {
  LogGroupEventSourceFunction,
} from "./event-source-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

describe.sequential("AWS.Logs.LogGroupEventSource", () => {
  test.provider(
    "delivers decoded log events through the Lambda event source",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* stack.deploy(
          LogGroupEventSourceFunction.pipe(
            Effect.provide(LogGroupEventSourceFunctionLive),
          ),
        );

        const functionUrl = fn.functionUrl!;

        // First request rides out cold-start / URL propagation; keep polling
        // until the fixture reports its identifiers.
        const { sourceLogGroupName, resultQueueUrl } = yield* HttpClient.get(
          functionUrl,
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? (response.json as Effect.Effect<{
                  sourceLogGroupName?: string;
                  resultQueueUrl?: string;
                }>)
              : Effect.fail(
                  new FunctionNotReady(
                    `Function not ready: ${response.status}`,
                  ),
                ),
          ),
          Effect.flatMap((body) =>
            body.sourceLogGroupName && body.resultQueueUrl
              ? Effect.succeed(
                  body as {
                    sourceLogGroupName: string;
                    resultQueueUrl: string;
                  },
                )
              : Effect.fail(
                  new FunctionNotReady("Function returned empty identifiers"),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("1 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );

        // Deploy-shape assertion (ungated): the subscription filter targeting
        // the Lambda exists on the source log group.
        const described = yield* logs.describeSubscriptionFilters({
          logGroupName: sourceLogGroupName,
        });
        const filter = (described.subscriptionFilters ?? []).find((f) =>
          f.destinationArn?.includes(fn.functionName),
        );
        expect(filter).toBeDefined();
        expect(filter?.destinationArn).toContain(":function:");

        // Write a marker log event into the source group out-of-band; the
        // subscription delivers it to the Lambda, which decodes the gzipped
        // payload and forwards the message to the result queue.
        const marker = `log-event-source-${crypto.randomUUID()}`;
        const logStreamName = "alchemy-test-event-source-stream";
        yield* logs
          .createLogStream({
            logGroupName: sourceLogGroupName,
            logStreamName,
          })
          .pipe(
            Effect.catchTag(
              "ResourceAlreadyExistsException",
              () => Effect.void,
            ),
          );
        const timestamp = yield* Clock.currentTimeMillis;
        yield* logs.putLogEvents({
          logGroupName: sourceLogGroupName,
          logStreamName,
          logEvents: [{ timestamp, message: marker }],
        });

        // Poll the result queue until the forwarded marker shows up.
        // Subscription delivery latency is typically a few seconds; bounded at
        // ~30 polls × (2s long-poll + 1s spacing) ≈ 90s.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: resultQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find(
            (message) => message.Body === marker,
          );
          if (!match?.ReceiptHandle) {
            return yield* Effect.fail(new MessageNotDelivered());
          }
          yield* SQS.deleteMessage({
            QueueUrl: resultQueueUrl,
            ReceiptHandle: match.ReceiptHandle,
          });
          return match.Body!;
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "MessageNotDelivered",
            schedule: Schedule.max([
              Schedule.fixed("1 seconds"),
              Schedule.recurs(30),
            ]),
          }),
        );

        expect(received).toEqual(marker);

        yield* stack.destroy();

        // The subscription filter is deleted with the log group.
        const afterDestroy = yield* logs
          .describeSubscriptionFilters({ logGroupName: sourceLogGroupName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ subscriptionFilters: [] }),
            ),
          );
        expect(afterDestroy.subscriptionFilters ?? []).toHaveLength(0);
      }),
    { timeout: 240_000 },
  );
});
