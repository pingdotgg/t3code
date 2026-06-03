import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageBatchRequest extends Omit<
  sqs.SendMessageBatchRequest,
  "QueueUrl"
> {}

export class SendMessageBatch extends Binding.Service<
  SendMessageBatch,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageBatchRequest,
    ) => Effect.Effect<sqs.SendMessageBatchResult, sqs.SendMessageBatchError>
  >
>()("AWS.SQS.SendMessageBatch") {}

export const SendMessageBatchLive = Layer.effect(
  SendMessageBatch,
  Effect.gen(function* () {
    const Policy = yield* SendMessageBatchPolicy;
    const sendMessageBatch = yield* sqs.sendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: SendMessageBatchRequest) {
        return yield* sendMessageBatch({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class SendMessageBatchPolicy extends Binding.Policy<
  SendMessageBatchPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.SendMessageBatch") {}

export const SendMessageBatchPolicyLive = SendMessageBatchPolicy.layer.succeed(
  Effect.fn(function* (host, queue) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SQS.SendMessageBatch(${queue}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sqs:SendMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `SendMessageBatchPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
