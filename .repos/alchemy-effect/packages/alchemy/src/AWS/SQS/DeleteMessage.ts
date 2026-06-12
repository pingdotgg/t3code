import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageRequest extends Omit<
  sqs.DeleteMessageRequest,
  "QueueUrl"
> {}

export class DeleteMessage extends Binding.Service<
  DeleteMessage,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageRequest,
    ) => Effect.Effect<sqs.DeleteMessageResponse, sqs.DeleteMessageError>
  >
>()("AWS.SQS.DeleteMessage") {}

export const DeleteMessageLive = Layer.effect(
  DeleteMessage,
  Effect.gen(function* () {
    const Policy = yield* DeleteMessagePolicy;
    const deleteMessage = yield* sqs.deleteMessage;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: DeleteMessageRequest) {
        return yield* deleteMessage({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class DeleteMessagePolicy extends Binding.Policy<
  DeleteMessagePolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.DeleteMessage") {}

export const DeleteMessagePolicyLive = DeleteMessagePolicy.layer.succeed(
  Effect.fn(function* (host, queue) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.SQS.DeleteMessage(${queue}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["sqs:DeleteMessage"],
            Resource: [Output.interpolate`${queue.queueArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DeleteMessagePolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
