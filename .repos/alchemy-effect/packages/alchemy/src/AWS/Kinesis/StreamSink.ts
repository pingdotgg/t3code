import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { PutRecords } from "./PutRecords.ts";
import type { Stream } from "./Stream.ts";

export type StreamSinkRecord = Kinesis.PutRecordsRequestEntry;

export class StreamSink extends Binding.Service<
  StreamSink,
  (
    stream: Stream,
  ) => Effect.Effect<
    Sink.Sink<void, StreamSinkRecord, readonly StreamSinkRecord[], never>
  >
>()("AWS.Kinesis.StreamSink") {}

/**
 * A partition-aware sink for batching `PutRecords` requests into a stream.
 *
 * Each input element is a raw `PutRecordsRequestEntry`, so callers stay in
 * control of `PartitionKey` and optional `ExplicitHashKey`.
 */
export const StreamSinkLive = Layer.effect(
  StreamSink,
  Effect.gen(function* () {
    const Policy = yield* StreamSinkPolicy;
    const putRecords = yield* PutRecords;

    return Effect.fn(function* (stream: Stream) {
      yield* Policy(stream);
      const publish = yield* putRecords(stream);
      return Sink.forEachArray((records: readonly StreamSinkRecord[]) =>
        publish({
          Records: [...records],
        }).pipe(Effect.orDie, Effect.asVoid),
      );
    });
  }),
);

export class StreamSinkPolicy extends Binding.Policy<
  StreamSinkPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.StreamSink") {}

export const StreamSinkPolicyLive = StreamSinkPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.StreamSink(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:PutRecords"],
            Resource: [stream.streamArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `StreamSinkPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
