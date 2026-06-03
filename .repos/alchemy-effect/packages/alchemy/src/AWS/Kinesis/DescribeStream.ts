import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamRequest extends Omit<
  Kinesis.DescribeStreamInput,
  "StreamName" | "StreamARN"
> {}

export class DescribeStream extends Binding.Service<
  DescribeStream,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamOutput,
      Kinesis.DescribeStreamError
    >
  >
>()("AWS.Kinesis.DescribeStream") {}

export const DescribeStreamLive = Layer.effect(
  DescribeStream,
  Effect.gen(function* () {
    const Policy = yield* DescribeStreamPolicy;
    const describeStream = yield* Kinesis.describeStream;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request?: DescribeStreamRequest) {
        return yield* describeStream({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);

export class DescribeStreamPolicy extends Binding.Policy<
  DescribeStreamPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.DescribeStream") {}

export const DescribeStreamPolicyLive = DescribeStreamPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStream(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:DescribeStream"],
            Resource: [stream.streamArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DescribeStreamPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
