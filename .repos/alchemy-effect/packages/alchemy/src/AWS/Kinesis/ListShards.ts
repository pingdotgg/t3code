import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface ListShardsRequest extends Omit<
  Kinesis.ListShardsInput,
  "StreamName" | "StreamARN"
> {}

export class ListShards extends Binding.Service<
  ListShards,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListShardsRequest,
    ) => Effect.Effect<Kinesis.ListShardsOutput, Kinesis.ListShardsError>
  >
>()("AWS.Kinesis.ListShards") {}

export const ListShardsLive = Layer.effect(
  ListShards,
  Effect.gen(function* () {
    const Policy = yield* ListShardsPolicy;
    const listShards = yield* Kinesis.listShards;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request?: ListShardsRequest) {
        return yield* listShards({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);

export class ListShardsPolicy extends Binding.Policy<
  ListShardsPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.ListShards") {}

export const ListShardsPolicyLive = ListShardsPolicy.layer.succeed(
  Effect.fn(function* (host, stream) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.ListShards(${stream}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:ListShards"],
            Resource: [stream.streamArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListShardsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
