import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest extends Omit<
  sqs.SendMessageRequest,
  "QueueUrl"
> {}

export class SendMessage extends Binding.Service<
  SendMessage,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageRequest,
    ) => Effect.Effect<sqs.SendMessageResult, sqs.SendMessageError>
  >
>()("AWS.SQS.SendMessage") {}

export const SendMessageLive = Layer.effect(
  SendMessage,
  Effect.gen(function* () {
    const Policy = yield* SendMessagePolicy;
    const sendMessage = yield* sqs.sendMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: SendMessageRequest) {
        return yield* sendMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
          MessageBody: request.MessageBody,
        });
      });
    });
  }),
);

export class SendMessagePolicy extends Binding.Policy<
  SendMessagePolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.SendMessage") {}

export const SendMessagePolicyLive = SendMessagePolicy.layer.succeed(
  Effect.fn(function* (host, queue) {
    if (isFunction(host) || isInstance(host)) {
      yield* host.bind`Allow(${host}, AWS.SQS.SendMessage(${queue}))`({
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
        `SendMessagePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
