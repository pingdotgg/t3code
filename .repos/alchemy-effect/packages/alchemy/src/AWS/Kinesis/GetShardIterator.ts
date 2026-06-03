import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface GetShardIteratorRequest extends Omit<
  Kinesis.GetShardIteratorInput,
  "StreamName" | "StreamARN"
> {}

export class GetShardIterator extends Binding.Service<
  GetShardIterator,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetShardIteratorRequest,
    ) => Effect.Effect<
      Kinesis.GetShardIteratorOutput,
      Kinesis.GetShardIteratorError
    >
  >
>()("AWS.Kinesis.GetShardIterator") {}

export const GetShardIteratorLive = Layer.effect(
  GetShardIterator,
  Effect.gen(function* () {
    const Policy = yield* GetShardIteratorPolicy;
    const getShardIterator = yield* Kinesis.getShardIterator;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request: GetShardIteratorRequest) {
        return yield* getShardIterator({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);

export class GetShardIteratorPolicy extends Binding.Policy<
  GetShardIteratorPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.GetShardIterator") {}

export const GetShardIteratorPolicyLive = GetShardIteratorPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.GetShardIterator(${stream}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:GetShardIterator"],
              Resource: [stream.streamArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `GetShardIteratorPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
