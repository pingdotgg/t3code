import type * as Kinesis from "@distilled.cloud/aws/kinesis";
import { makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { PutRecords } from "./PutRecords.ts";
import type { Stream } from "./Stream.ts";
import { StreamSink, type StreamSinkRecord } from "./StreamSink.ts";

const encoder = new TextEncoder();

export const StreamSinkHttp = Layer.effect(
  StreamSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putRecords = yield* PutRecords;

    return Effect.fn(function* (stream: Stream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Kinesis.StreamSink(${stream})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:PutRecords"],
              Resource: [stream.streamArn],
            },
          ],
        });
      }
      const publish = yield* putRecords(stream);
      return makeBatchedSink<StreamSinkRecord, Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>({
        maxRecords: 500,
        maxBytes: 5 * 1024 * 1024,
        sizeOf: (record) => record.Data.length + encoder.encode(record.PartitionKey).length,
        send: (batch) => publish({ Records: [...batch] }),
        // PutRecords failures are positional: Records[i] mirrors the request
        // order and carries an ErrorCode (throughput exceeded / internal
        // failure) — all transient, so re-submit them on the bounded schedule.
        unprocessed: (out, batch) => {
          if (!out.FailedRecordCount) {
            return [];
          }
          return batch.filter((_, index) => out.Records[index]?.ErrorCode !== undefined);
        },
      });
    });
  }),
);
