import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequest extends Omit<
  Kinesis.PutRecordsInput,
  "StreamName"
> {}

export class PutRecords extends Binding.Service<
  PutRecords,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordsRequest,
    ) => Effect.Effect<Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>
  >
>()("AWS.Kinesis.PutRecords") {}

export const PutRecordsLive = Layer.effect(
  PutRecords,
  Effect.gen(function* () {
    const Policy = yield* PutRecordsPolicy;
    const putRecords = yield* Kinesis.putRecords;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      yield* Policy(stream);
      return Effect.fn(function* (request: PutRecordsRequest) {
        return yield* putRecords({
          ...request,
          StreamName: yield* StreamName,
        });
      });
    });
  }),
);

export class PutRecordsPolicy extends Binding.Policy<
  PutRecordsPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.PutRecords") {}

export const PutRecordsPolicyLive = PutRecordsPolicy.layer.succeed(
  Effect.fn(function* (host, stream: Stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.PutRecords(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:PutRecords"],
            Resource: [Output.interpolate`${stream.streamArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutRecordsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
