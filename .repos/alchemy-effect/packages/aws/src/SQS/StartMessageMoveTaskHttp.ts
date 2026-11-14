import * as sqs from "@distilled.cloud/aws/sqs";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Queue } from "./Queue.ts";
import { StartMessageMoveTask, type StartMessageMoveTaskRequest } from "./StartMessageMoveTask.ts";

// Bespoke (not the shared scaffold): redrive spans TWO queues. The source
// (DLQ) needs the start/receive/delete/get-attributes actions, and the
// destination needs send/get-attributes — on `*` when no explicit
// destination is given, because "redrive to original source queues" targets
// queues unknowable at deploy time.
export const StartMessageMoveTaskHttp = Layer.effect(
  StartMessageMoveTask,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startMessageMoveTask = yield* AWSBindings.withCredentials(sqs.startMessageMoveTask);

    return Effect.fn(function* (source: Queue, options?: { destination?: Queue }) {
      const SourceArn = yield* source.queueArn;
      const destination = options?.destination;
      const DestinationArn = destination ? yield* destination.queueArn : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SQS.StartMessageMoveTask(${source})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "sqs:StartMessageMoveTask",
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              Resource: [Output.interpolate`${source.queueArn}`],
            },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage", "sqs:GetQueueAttributes"],
              Resource: [destination ? Output.interpolate`${destination.queueArn}` : "*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.SQS.StartMessageMoveTask(${source.LogicalId})`)(function* (
        request?: StartMessageMoveTaskRequest,
      ) {
        return yield* startMessageMoveTask({
          ...request,
          SourceArn: yield* SourceArn,
          ...(DestinationArn !== undefined ? { DestinationArn: yield* DestinationArn } : {}),
        });
      });
    });
  }),
);
