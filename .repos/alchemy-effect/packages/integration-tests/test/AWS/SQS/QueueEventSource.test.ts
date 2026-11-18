import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import QueueEventSourceFunctionLive, { QueueEventSourceFunction } from "./event-source-handler.ts";
import InlineQueueEventSourceFunction from "./inline-event-source-handler.ts";
import PartialFailureFunctionLive, { PartialFailureFunction } from "./partial-failure-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential(
  "AWS.SQS.QueueEventSource",
  { tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"] },
  () => {
    // `fn` is deployed by the caller so both the class and the inline
    // `Lambda.Function` forms run the same end-to-end delivery check.
    const deliversThroughEventSource = (
      stack: Test.ScratchStack,
      deployFunction: Effect.Effect<{ functionName: string; functionUrl?: string }, any, any>,
    ) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* deployFunction;

        const functionUrl = fn.functionUrl!;

        const { sourceQueueUrl, sourceQueueArn, resultQueueUrl } =
          yield* waitForFunctionQueues(functionUrl);

        // The event-source mapping activates asynchronously after deploy.
        const mapping = yield* waitForEventSourceMappingEnabled(fn.functionName, sourceQueueArn);
        expect(mapping.State).toEqual("Enabled");

        // Send a message to the source queue out-of-band; the Lambda handler
        // forwards its body to the result queue via QueueSink.
        const messageBody = `event-source-${crypto.randomUUID()}`;
        yield* SQS.sendMessage({ QueueUrl: sourceQueueUrl, MessageBody: messageBody });

        // Poll the result queue until the forwarded body shows up. Bounded:
        // ~30 polls, each an SQS long-poll of 2s.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: resultQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find((message) => message.Body === messageBody);
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
            schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
          }),
        );

        expect(received).toEqual(messageBody);

        yield* stack.destroy();

        // Out-of-band: both queues are actually gone after the destroy.
        yield* assertQueueDeleted(sourceQueueUrl);
        yield* assertQueueDeleted(resultQueueUrl);
      });

    test.provider(
      "delivers real SQS messages through the Lambda event source",
      (stack) =>
        deliversThroughEventSource(
          stack,
          stack.deploy(QueueEventSourceFunction.pipe(Effect.provide(QueueEventSourceFunctionLive))),
        ),
      { timeout: 240_000 },
    );

    test.provider(
      "an inline Lambda.Function can consume its event source",
      (stack) => deliversThroughEventSource(stack, stack.deploy(InlineQueueEventSourceFunction)),
      { timeout: 240_000 },
    );

    test.provider(
      "retries only the messages reported in batchItemFailures",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const fn = yield* stack.deploy(
            PartialFailureFunction.pipe(Effect.provide(PartialFailureFunctionLive)),
          );
          const { sourceQueueUrl, sourceQueueArn, resultQueueUrl } = yield* waitForFunctionQueues(
            fn.functionUrl!,
          );
          yield* waitForEventSourceMappingEnabled(fn.functionName, sourceQueueArn);

          // One send so both messages land in the same batch (the mapping
          // gathers for up to 3 seconds).
          const ok = `ok-${crypto.randomUUID()}`;
          const fail = `fail-${crypto.randomUUID()}`;
          yield* SQS.sendMessageBatch({
            QueueUrl: sourceQueueUrl,
            Entries: [
              { Id: "ok", MessageBody: ok },
              { Id: "fail", MessageBody: fail },
            ],
          });

          // The handler forwards `<body>#<receiveCount>`. Collect until the
          // failed message has come back on its retry (visibility timeout 10s).
          const forwarded = new Set<string>();
          yield* Effect.gen(function* () {
            const result = yield* SQS.receiveMessage({
              QueueUrl: resultQueueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 2,
            });
            for (const message of result.Messages ?? []) {
              forwarded.add(message.Body!);
              yield* SQS.deleteMessage({
                QueueUrl: resultQueueUrl,
                ReceiptHandle: message.ReceiptHandle!,
              });
            }
            if (!forwarded.has(`${fail}#2`)) {
              return yield* Effect.fail(new MessageNotDelivered());
            }
          }).pipe(
            Effect.retry({
              while: (error) => error._tag === "MessageNotDelivered",
              // Lambda redelivers the failed message once its 10s visibility
              // timeout lapses and the poller picks it up again.
              schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(30)]),
            }),
          );

          // The successful message was deleted after its first delivery and
          // never reprocessed; only the failed one was retried.
          expect([...forwarded].filter((body) => body.startsWith(ok))).toEqual([`${ok}#1`]);
          expect([...forwarded].filter((body) => body.startsWith(fail))).toEqual([`${fail}#2`]);

          yield* stack.destroy();

          yield* assertQueueDeleted(sourceQueueUrl);
          yield* assertQueueDeleted(resultQueueUrl);
        }),
      { timeout: 240_000 },
    );
  },
);

/** Poll the fixture's Function URL until it reports its queue identifiers. */
const waitForFunctionQueues = Effect.fn(function* (functionUrl: string) {
  // First request rides out cold-start / URL propagation; keep polling until
  // the fixture reports the queue identifiers.
  return yield* HttpClient.get(functionUrl).pipe(
    Effect.timeout("4 seconds"),
    Effect.mapError(() => new FunctionNotReady("Function URL request timed out")),
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<{
            sourceQueueUrl?: string;
            sourceQueueArn?: string;
            resultQueueUrl?: string;
          }>)
        : Effect.fail(new FunctionNotReady(`Function not ready: ${response.status}`)),
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
        : Effect.fail(new FunctionNotReady("Function returned empty queue identifiers")),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("4 seconds"), Schedule.recurs(10)]),
    }),
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
      schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]),
    }),
  );
});

class QueueStillExists extends Data.TaggedError("QueueStillExists") {}

/** Poll (bounded) until GetQueueAttributes reports the queue gone. */
const assertQueueDeleted = Effect.fn(function* (queueUrl: string) {
  yield* SQS.getQueueAttributes({ QueueUrl: queueUrl, AttributeNames: ["All"] }).pipe(
    Effect.flatMap(() => Effect.fail(new QueueStillExists())),
    Effect.retry({
      // SQS DeleteQueue propagation is documented at ~60s; poll on a fixed
      // cadence with a bounded budget.
      while: (e) => e._tag === "QueueStillExists",
      schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(10)]),
    }),
    Effect.catchTag("QueueDoesNotExist", () => Effect.void),
  );
});

class EventSourceMappingNotReady extends Data.TaggedError("EventSourceMappingNotReady") {}

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{ message: string }> {
  constructor(message: string) {
    super({ message });
  }
}
