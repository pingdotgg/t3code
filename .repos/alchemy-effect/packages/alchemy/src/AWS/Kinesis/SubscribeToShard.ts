import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface SubscribeToShardRequest extends Omit<
  Kinesis.SubscribeToShardInput,
  "ConsumerARN"
> {}

export class SubscribeToShard extends Binding.Service<
  SubscribeToShard,
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request: SubscribeToShardRequest,
    ) => Effect.Effect<
      Kinesis.SubscribeToShardOutput,
      Kinesis.SubscribeToShardError
    >
  >
>()("AWS.Kinesis.SubscribeToShard") {}

export const SubscribeToShardLive = Layer.effect(
  SubscribeToShard,
  Effect.gen(function* () {
    const Policy = yield* SubscribeToShardPolicy;
    const subscribeToShard = yield* Kinesis.subscribeToShard;

    return Effect.fn(function* (consumer: StreamConsumer) {
      const ConsumerARN = yield* consumer.consumerArn;
      yield* Policy(consumer);
      return Effect.fn(function* (request: SubscribeToShardRequest) {
        return yield* subscribeToShard({
          ...request,
          ConsumerARN: yield* ConsumerARN,
        });
      });
    });
  }),
);

export class SubscribeToShardPolicy extends Binding.Policy<
  SubscribeToShardPolicy,
  (consumer: StreamConsumer) => Effect.Effect<void>
>()("AWS.Kinesis.SubscribeToShard") {}

export const SubscribeToShardPolicyLive = SubscribeToShardPolicy.layer.succeed(
  Effect.fn(function* (host, consumer) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.SubscribeToShard(${consumer}))`(
        {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["kinesis:SubscribeToShard"],
              Resource: [consumer.consumerArn],
            },
          ],
        },
      );
    } else {
      return yield* Effect.die(
        `SubscribeToShardPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
