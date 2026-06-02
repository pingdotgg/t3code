import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest extends Omit<
  Kinesis.PutRecordInput,
  "StreamName"
> {}

export class PutRecord extends Binding.Service<
  PutRecord,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Kinesis.PutRecordOutput, Kinesis.PutRecordError>
  >
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordLive = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const Policy = yield* PutRecordPolicy;
    const putRecord = yield* Kinesis.putRecord;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      yield* Policy(stream);
      return Effect.fn(function* (request: PutRecordRequest) {
        return yield* putRecord({
          ...request,
          StreamName: yield* StreamName,
        });
      });
    });
  }),
);

export class PutRecordPolicy extends Binding.Policy<
  PutRecordPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordPolicyLive = PutRecordPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.PutRecord(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:PutRecord"],
            Resource: [Output.interpolate`${stream.streamArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `PutRecordPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
