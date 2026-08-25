import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import QueueEventSourceFunctionLive, {
  QueueEventSourceFunction,
} from "./event-source-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("AWS.SQS.QueueEventSource", () => {
  test.provider(
    "delivers real SQS messages through the Lambda event source",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* stack.deploy(
          QueueEventSourceFunction.pipe(
            Effect.provide(QueueEventSourceFunctionLive),
          ),
        );

        const functionUrl = fn.functionUrl!;

        // First request rides out cold-start / URL propagation; keep polling
        // until the fixture reports both queue identifiers.
        const { sourceQueueUrl, sourceQueueArn, resultQueueUrl } =
          yield* HttpClient.get(functionUrl).pipe(
            Effect.timeout("4 seconds"),
            Effect.mapError(
              () => new FunctionNotReady("Function URL request timed out"),
            ),
            Effect.flatMap((response) =>
              response.status === 200
                ? (response.json as Effect.Effect<{
                    sourceQueueUrl?: string;
                    sourceQueueArn?: string;
                    resultQueueUrl?: string;
                  }>)
                : Effect.fail(
                    new FunctionNotReady(
                      `Function not ready: ${response.status}`,
                    ),
                  ),
            ),
            Effect.flatMap((body) =>
              body.sourceQueueUrl && body.sourceQueueArn && body.resultQueueUrl
                ? Effect.succeed(
                    body as {
                      sourceQueueUrl: string;
                      sourceQueueArn: string;
                      resultQueueUrl: string;
                    },
                  )
                : Effect.fail(
                    new FunctionNotReady(
                      "Function returned empty queue identifiers",
                    ),
                  ),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.fixed("4 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );

        // The event-source mapping activates asynchronously after deploy.
        const mapping = yield* waitForEventSourceMappingEnabled(
          fn.functionName,
          sourceQueueArn,
        );
        expect(mapping.State).toEqual("Enabled");

        // Send a message to the source queue out-of-band; the Lambda handler
        // forwards its body to the result queue via QueueSink.
        const messageBody = `event-source-${crypto.randomUUID()}`;
        yield* SQS.sendMessage({
          QueueUrl: sourceQueueUrl,
          MessageBody: messageBody,
        });

        // Poll the result queue until the forwarded body shows up. Bounded:
        // ~30 polls, each an SQS long-poll of 2s.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: resultQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find(
            (message) => message.Body === messageBody,
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
              Schedule.fixed("3 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );

        expect(received).toEqual(messageBody);

        yield* stack.destroy();

        // Out-of-band: both queues are actually gone after the destroy.
        yield* assertQueueDeleted(sourceQueueUrl);
        yield* assertQueueDeleted(resultQueueUrl);
      }),
    { timeout: 240_000 },
  );
});

const waitForEventSourceMappingEnabled = Effect.fn(function* (
  functionName: string,
  eventSourceArn: string,
) {
  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      if (!mapping || mapping.State !== "Enabled") {
        return Effect.fail(new EventSourceMappingNotReady());
      }
      return Effect.succeed(mapping);
    }),
    Effect.retry({
      while: (error) => error._tag === "EventSourceMappingNotReady",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
});

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

/** Poll (bounded) until GetQueueAttributes reports the queue gone. */
const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["All"],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      // SQS DeleteQueue propagation is documented at ~60s; poll on a fixed
      // cadence with a bounded budget.
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.max([
        Schedule.spaced("5 seconds"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
});

class EventSourceMappingNotReady extends Data.TaggedError(
  "EventSourceMappingNotReady",
) {}

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
