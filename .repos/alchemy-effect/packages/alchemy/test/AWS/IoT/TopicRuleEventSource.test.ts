import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IoTEventSourceFunctionLive, {
  IoTEventSourceFunction,
} from "./iot-event-source-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("AWS.IoT.TopicRuleEventSource", () => {
  test.provider(
    "publishes via the Publish binding, routes through the topic rule, and observes delivery",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* stack.deploy(
          IoTEventSourceFunction.pipe(
            Effect.provide(IoTEventSourceFunctionLive),
          ),
        );
        const functionUrl = fn.functionUrl!.replace(/\/+$/, "");

        // Ride out cold-start / URL propagation until /ready reports the queue.
        const { resultQueueUrl } = yield* HttpClient.get(
          `${functionUrl}/ready`,
        ).pipe(
          // Bound each fetch attempt so a transient Function URL DNS/socket
          // stall reaches the retry schedule instead of consuming the whole
          // test timeout.
          Effect.timeout("4 seconds"),
          Effect.mapError(() => new FunctionNotReady("ready request")),
          Effect.flatMap((response) =>
            response.status === 200
              ? (response.json as Effect.Effect<{ resultQueueUrl?: string }>)
              : Effect.fail(new FunctionNotReady(`status ${response.status}`)),
          ),
          Effect.flatMap((body) =>
            body.resultQueueUrl
              ? Effect.succeed(body as { resultQueueUrl: string })
              : Effect.fail(new FunctionNotReady("no result queue")),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );

        // Publish a uniquely-marked message from inside the Lambda via the IoT
        // Publish binding. The topic rule matches it and re-invokes the Lambda,
        // whose event-source handler forwards it into the result queue.
        const marker = `iot-${crypto.randomUUID()}`;
        yield* HttpClient.execute(
          HttpClientRequest.post(`${functionUrl}/publish`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ marker }),
          ),
        ).pipe(
          Effect.timeout("4 seconds"),
          Effect.mapError(() => new FunctionNotReady("publish request")),
          Effect.filterOrFail(
            (response) => response.status === 200,
            (response) => new FunctionNotReady(`publish ${response.status}`),
          ),
          Effect.retry({
            while: (e) => e._tag === "FunctionNotReady",
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );

        // Poll the result queue until the forwarded message (carrying the
        // marker) shows up. IoT rule and permission propagation are eventually
        // consistent, so republish while waiting, bounded to about 50 seconds.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: resultQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
          });
          const match = (result.Messages ?? []).find((message) =>
            message.Body?.includes(marker),
          );
          if (!match?.ReceiptHandle) {
            // Republish in case the earlier publish predated rule/permission
            // readiness.
            yield* HttpClient.execute(
              HttpClientRequest.post(`${functionUrl}/publish`).pipe(
                HttpClientRequest.bodyJsonUnsafe({ marker }),
              ),
            ).pipe(Effect.timeout("4 seconds"), Effect.ignore);
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

        expect(received).toContain(marker);

        yield* stack.destroy();

        // Assert the stack's observable resources are gone: the Lambda
        // function (which hosted the event source) and the result queue.
        yield* Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
          Effect.flatMap(() => Effect.fail(new ResourceStillExists("lambda"))),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "ResourceStillExists",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
        // SQS DeleteQueue propagation is documented at up to ~60s.
        yield* SQS.getQueueAttributes({
          QueueUrl: resultQueueUrl,
          AttributeNames: ["All"],
        }).pipe(
          Effect.flatMap(() => Effect.fail(new ResourceStillExists("queue"))),
          Effect.catchTag("QueueDoesNotExist", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "ResourceStillExists",
            schedule: Schedule.max([
              Schedule.spaced("5 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
      }),
    { timeout: 180_000 },
  );
});

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class ResourceStillExists extends Data.TaggedError("ResourceStillExists")<{
  what: string;
}> {
  constructor(what: string) {
    super({ what });
  }
}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
