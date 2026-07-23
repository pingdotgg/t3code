import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamSummaryRequest extends Omit<
  Kinesis.DescribeStreamSummaryInput,
  "StreamName" | "StreamARN"
> {}

export class DescribeStreamSummary extends Binding.Service<
  DescribeStreamSummary,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamSummaryRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamSummaryOutput,
      Kinesis.DescribeStreamSummaryError
    >
  >
>()("AWS.Kinesis.DescribeStreamSummary") {}

export const DescribeStreamSummaryLive = Layer.effect(
  DescribeStreamSummary,
  Effect.gen(function* () {
    const Policy = yield* DescribeStreamSummaryPolicy;
    const describeStreamSummary = yield* Kinesis.describeStreamSummary;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request?: DescribeStreamSummaryRequest) {
        return yield* describeStreamSummary({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);

export class DescribeStreamSummaryPolicy extends Binding.Policy<
  DescribeStreamSummaryPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.DescribeStreamSummary") {}

export const DescribeStreamSummaryPolicyLive =
  DescribeStreamSummaryPolicy.layer.succeed(
    Effect.fn(function* (host, stream) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStreamSummary(${stream}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:DescribeStreamSummary"],
                Resource: [stream.streamArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeStreamSummaryPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
