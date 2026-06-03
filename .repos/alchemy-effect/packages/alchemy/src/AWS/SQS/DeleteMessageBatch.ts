import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isInstance } from "../EC2/Instance.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Queue } from "./Queue.ts";

export interface DeleteMessageBatchRequest extends Omit<
  sqs.DeleteMessageBatchRequest,
  "QueueUrl"
> {}

export class DeleteMessageBatch extends Binding.Service<
  DeleteMessageBatch,
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: DeleteMessageBatchRequest,
    ) => Effect.Effect<
      sqs.DeleteMessageBatchResult,
      sqs.DeleteMessageBatchError
    >
  >
>()("AWS.SQS.DeleteMessageBatch") {}

export const DeleteMessageBatchLive = Layer.effect(
  DeleteMessageBatch,
  Effect.gen(function* () {
    const Policy = yield* DeleteMessageBatchPolicy;
    const deleteMessageBatch = yield* sqs.deleteMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      const QueueUrl = yield* queue.queueUrl;
      yield* Policy(queue);
      return Effect.fn(function* (request: DeleteMessageBatchRequest) {
        return yield* deleteMessageBatch({
          ...request,
          QueueUrl: yield* QueueUrl,
        });
      });
    });
  }),
);

export class DeleteMessageBatchPolicy extends Binding.Policy<
  DeleteMessageBatchPolicy,
  (queue: Queue) => Effect.Effect<void>
>()("AWS.SQS.DeleteMessageBatch") {}

export const DeleteMessageBatchPolicyLive =
  DeleteMessageBatchPolicy.layer.succeed(
    Effect.fn(function* (host, queue) {
      if (isFunction(host) || isInstance(host)) {
        yield* host.bind`Allow(${host}, AWS.SQS.DeleteMessageBatch(${queue}))`({
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
          `DeleteMessageBatchPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
