import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import PipeTargetFunctionLive, { PipeTargetFunction } from "./pipe-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("AWS.Pipes delivery", () => {
  test.provider(
    "delivers SQS messages through a pipe to the Lambda target",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const fn = yield* stack.deploy(
          PipeTargetFunction.pipe(Effect.provide(PipeTargetFunctionLive)),
        );

        const functionUrl = fn.functionUrl!;

        // First request rides out cold-start / URL propagation; keep polling
        // until the fixture reports both queue identifiers.
        const { sourceQueueUrl, sinkQueueUrl } = yield* HttpClient.get(
          functionUrl,
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? (response.json as Effect.Effect<{
                  sourceQueueUrl?: string;
                  sinkQueueUrl?: string;
                }>)
              : Effect.fail(
                  new FunctionNotReady(
                    `Function not ready: ${response.status}`,
                  ),
                ),
          ),
          Effect.flatMap((body) =>
            body.sourceQueueUrl && body.sinkQueueUrl
              ? Effect.succeed(
                  body as { sourceQueueUrl: string; sinkQueueUrl: string },
                )
              : Effect.fail(
                  new FunctionNotReady(
                    "Function returned empty queue identifiers",
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("1 seconds"),
              Schedule.recurs(45),
            ]),
          }),
        );

        // The Pipe provider waits for RUNNING inside reconcile, so the pipe
        // is already active. Send a message to the source queue out-of-band;
        // the pipe delivers it to the Lambda target, whose listener forwards
        // the body into the sink queue.
        const messageBody = `pipe-delivery-${crypto.randomUUID()}`;
        yield* SQS.sendMessage({
          QueueUrl: sourceQueueUrl,
          MessageBody: messageBody,
        });

        // Poll the sink queue until the forwarded body shows up. Nine 8s
        // long polls with 500ms spacing give delivery a bounded ~76s budget
        // without spending half the time asleep between polls.
        const received = yield* Effect.gen(function* () {
          const result = yield* SQS.receiveMessage({
            QueueUrl: sinkQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 8,
          });
          const match = (result.Messages ?? []).find(
            (message) => message.Body === messageBody,
          );
          if (!match?.ReceiptHandle) {
            return yield* Effect.fail(new MessageNotDelivered());
          }
          yield* SQS.deleteMessage({
            QueueUrl: sinkQueueUrl,
            ReceiptHandle: match.ReceiptHandle,
          });
          return match.Body!;
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "MessageNotDelivered",
            schedule: Schedule.max([
              Schedule.spaced("500 millis"),
              Schedule.recurs(8),
            ]),
          }),
        );

        expect(received).toEqual(messageBody);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
