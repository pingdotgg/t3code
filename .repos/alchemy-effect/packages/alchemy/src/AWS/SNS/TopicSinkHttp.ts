import type * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { makeBatchedSink } from "../internal/BatchedSink.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { PublishBatch } from "./PublishBatch.ts";
import type { Topic } from "./Topic.ts";
import { TopicSink, type TopicSinkEntry } from "./TopicSink.ts";

const encoder = new TextEncoder();

/**
 * Select the original entries referenced by `Failed` results with the given
 * `SenderFault` classification, preserving input order. The sink assigns
 * `Id = String(index)` per call, so failed ids map back positionally.
 */
const selectFailed = (
  failed: readonly sns.BatchResultErrorEntry[] | undefined,
  batch: readonly TopicSinkEntry[],
  senderFault: boolean,
): readonly TopicSinkEntry[] => {
  if (failed === undefined || failed.length === 0) {
    return [];
  }
  const indices = new Set(
    failed
      .filter((entry) => entry.SenderFault === senderFault)
      .map((entry) => Number(entry.Id)),
  );
  return batch.filter((_, index) => indices.has(index));
};

export const TopicSinkHttp = Layer.effect(
  TopicSink,
  Effect.gen(function* () {
    const publishBatch = yield* PublishBatch;

    return Effect.fn(function* (topic: Topic) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.SNS.TopicSink(${topic}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sns:Publish"],
                Resource: [topic.topicArn],
              },
            ],
          });
        }
      }
      const publish = yield* publishBatch(topic);

      return makeBatchedSink<
        TopicSinkEntry,
        sns.PublishBatchResponse,
        sns.PublishBatchError
      >({
        maxRecords: 10,
        maxBytes: 262_144,
        sizeOf: (entry) => encoder.encode(entry.Message).length,
        send: (batch) =>
          publish({
            PublishBatchRequestEntries: batch.map((entry, index) => ({
              ...entry,
              Id: `${index}`,
            })),
          }),
        // SenderFault=false failures (throttling, internal errors) are
        // transient — re-submit them on the bounded schedule.
        unprocessed: (out, batch) => selectFailed(out.Failed, batch, false),
        // SenderFault=true failures are permanent — drop and surface.
        rejected: (out, batch) => selectFailed(out.Failed, batch, true),
      });
    });
  }),
);
