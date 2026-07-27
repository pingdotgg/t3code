import type * as Firehose from "@distilled.cloud/aws/firehose";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { makeBatchedSink } from "../internal/BatchedSink.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";
import {
  DeliveryStreamSink,
  type DeliveryStreamSinkRecord,
} from "./DeliveryStreamSink.ts";
import { PutRecordBatch } from "./PutRecordBatch.ts";

/**
 * HTTP implementation of {@link DeliveryStreamSink}. At deploy time it grants
 * `firehose:PutRecordBatch` on the bound delivery stream; at runtime it
 * batches stream elements into `PutRecordBatch` calls (500 records / 4 MiB)
 * with bounded retry of transient per-record failures. Provide this layer on
 * the Function using the sink.
 */
export const DeliveryStreamSinkHttp = Layer.effect(
  DeliveryStreamSink,
  Effect.gen(function* () {
    const putRecordBatch = yield* PutRecordBatch;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Firehose.DeliveryStreamSink(${deliveryStream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["firehose:PutRecordBatch"],
                  Resource: [
                    Output.interpolate`${deliveryStream.deliveryStreamArn}`,
                  ],
                },
              ],
            },
          );
        }
      }
      const send = yield* putRecordBatch(deliveryStream);
      return makeBatchedSink<
        DeliveryStreamSinkRecord,
        Firehose.PutRecordBatchOutput,
        Firehose.PutRecordBatchError
      >({
        maxRecords: 500,
        maxBytes: 4 * 1024 * 1024,
        sizeOf: (record) => record.Data.length,
        send: (batch) => send({ Records: [...batch] }),
        // PutRecordBatch failures are positional: RequestResponses[i] mirrors
        // the request order and carries an ErrorCode (ServiceUnavailable /
        // internal failure) — all transient, so re-submit them on the
        // bounded schedule.
        unprocessed: (out, batch) => {
          if (!out.FailedPutCount) {
            return [];
          }
          return batch.filter(
            (_, index) => out.RequestResponses[index]?.ErrorCode !== undefined,
          );
        },
      });
    });
  }),
);
