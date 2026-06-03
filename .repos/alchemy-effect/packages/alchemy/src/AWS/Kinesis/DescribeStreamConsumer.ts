import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface DescribeStreamConsumerRequest extends Omit<
  Kinesis.DescribeStreamConsumerInput,
  "ConsumerARN" | "StreamARN" | "ConsumerName"
> {}

export class DescribeStreamConsumer extends Binding.Service<
  DescribeStreamConsumer,
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request?: DescribeStreamConsumerRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamConsumerOutput,
      Kinesis.DescribeStreamConsumerError
    >
  >
>()("AWS.Kinesis.DescribeStreamConsumer") {}

export const DescribeStreamConsumerLive = Layer.effect(
  DescribeStreamConsumer,
  Effect.gen(function* () {
    const Policy = yield* DescribeStreamConsumerPolicy;
    const describeStreamConsumer = yield* Kinesis.describeStreamConsumer;

    return Effect.fn(function* (consumer: StreamConsumer) {
      const ConsumerARN = yield* consumer.consumerArn;
      yield* Policy(consumer);
      return Effect.fn(function* (request?: DescribeStreamConsumerRequest) {
        return yield* describeStreamConsumer({
          ...request,
          ConsumerARN: yield* ConsumerARN,
        });
      });
    });
  }),
);

export class DescribeStreamConsumerPolicy extends Binding.Policy<
  DescribeStreamConsumerPolicy,
  (consumer: StreamConsumer) => Effect.Effect<void>
>()("AWS.Kinesis.DescribeStreamConsumer") {}

export const DescribeStreamConsumerPolicyLive =
  DescribeStreamConsumerPolicy.layer.succeed(
    Effect.fn(function* (host, consumer) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeStreamConsumer(${consumer}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:DescribeStreamConsumer"],
                Resource: [consumer.consumerArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeStreamConsumerPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
