import type * as sqs from "@distilled.cloud/aws/sqs";
import * as Output from "alchemy/Output";
import { makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Queue } from "./Queue.ts";
import { QueueSink, type QueueSinkEntry } from "./QueueSink.ts";
import { SendMessageBatch } from "./SendMessageBatch.ts";

const encoder = new TextEncoder();

/**
 * Select the original entries referenced by `Failed` results with the given
 * `SenderFault` classification, preserving input order. The sink assigns
 * `Id = String(index)` per call, so failed ids map back positionally.
 */
const selectFailed = (
  failed: readonly sqs.BatchResultErrorEntry[] | undefined,
  batch: readonly QueueSinkEntry[],
  senderFault: boolean,
): readonly QueueSinkEntry[] => {
  if (failed === undefined || failed.length === 0) {
    return [];
  }
  const indices = new Set(
    failed.filter((entry) => entry.SenderFault === senderFault).map((entry) => Number(entry.Id)),
  );
  return batch.filter((_, index) => indices.has(index));
};

export const QueueSinkHttp = Layer.effect(
  QueueSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const sendMessageBatch = yield* SendMessageBatch;

    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.SQS.QueueSink(${queue})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage", "sqs:SendMessageBatch"],
              Resource: [Output.interpolate`${queue.queueArn}`],
            },
          ],
        });
      }
      const sendBatch = yield* sendMessageBatch(queue);
      return makeBatchedSink<QueueSinkEntry, sqs.SendMessageBatchResult, sqs.SendMessageBatchError>(
        {
          maxRecords: 10,
          maxBytes: 262_144,
          sizeOf: (entry) => encoder.encode(entry.MessageBody).length,
          send: (batch) =>
            sendBatch({
              Entries: batch.map((entry, index) => ({
                ...entry,
                Id: `${index}`,
              })),
            }),
          // SenderFault=false failures (throttling, internal errors) are
          // transient — re-submit them on the bounded schedule.
          unprocessed: (out, batch) => selectFailed(out.Failed, batch, false),
          // SenderFault=true failures are permanent — drop and surface.
          rejected: (out, batch) => selectFailed(out.Failed, batch, true),
        },
      );
    });
  }),
);
