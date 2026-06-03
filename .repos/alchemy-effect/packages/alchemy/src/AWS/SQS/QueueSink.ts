import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";
import { SendMessageBatch } from "./SendMessageBatch.ts";

export class QueueSink extends Binding.Service<
  QueueSink,
  (
    queue: Queue,
  ) => Effect.Effect<Sink.Sink<void, string, readonly string[], never>>
>()("AWS.SQS.QueueSink") {}

export const QueueSinkLive = Layer.effect(
  QueueSink,
  Effect.gen(function* () {
    const Policy = yield* QueueSinkPolicy;
    const sendMessageBatch = yield* SendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      yield* Policy(queue);
      const sendBatch = yield* sendMessageBatch(queue);
      return Sink.forEachArray((messages: readonly string[]) =>
        sendBatch({
          Entries: messages.map((message, i) => ({
            Id: `${i}`,
            MessageBody: message,
          })),
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);

export class QueueSinkPolicy extends Binding.Policy<
  QueueSinkPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.QueueSinkPolicy") {}

export const QueueSinkPolicyLive = QueueSinkPolicy.layer.succeed(
  Effect.fn(function* (host, queue) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SQS.QueueSink(${queue}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage", "sqs:SendMessageBatch"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `QueueSinkPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
