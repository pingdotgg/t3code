import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

export interface ReceiveMessageRequest extends Omit<
  sqs.ReceiveMessageRequest,
  "QueueUrl"
> {}

export class ReceiveMessage extends Binding.Service<
  ReceiveMessage,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: ReceiveMessageRequest,
    ) => Effect.Effect<sqs.ReceiveMessageResult, sqs.ReceiveMessageError>
  >
>()("AWS.SQS.ReceiveMessage") {}

export const ReceiveMessageLive = Layer.effect(
  ReceiveMessage,
  Effect.gen(function* () {
    const Policy = yield* ReceiveMessagePolicy;
    const receiveMessage = yield* sqs.receiveMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: ReceiveMessageRequest) {
        return yield* receiveMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class ReceiveMessagePolicy extends Binding.Policy<
  ReceiveMessagePolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.ReceiveMessage") {}

export const ReceiveMessagePolicyLive = ReceiveMessagePolicy.layer.succeed(
  Effect.fn(function* (host, queue) {
    if (isFunction(host) || isInstance(host)) {
      yield* host.bind`Allow(${host}, AWS.SQS.ReceiveMessage(${queue}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ReceiveMessagePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
