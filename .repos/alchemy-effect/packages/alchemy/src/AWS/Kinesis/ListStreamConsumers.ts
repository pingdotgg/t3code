import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface ListStreamConsumersRequest extends Omit<
  Kinesis.ListStreamConsumersInput,
  "StreamARN"
> {}

export class ListStreamConsumers extends Binding.Service<
  ListStreamConsumers,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListStreamConsumersRequest,
    ) => Effect.Effect<
      Kinesis.ListStreamConsumersOutput,
      Kinesis.ListStreamConsumersError
    >
  >
>()("AWS.Kinesis.ListStreamConsumers") {}

export const ListStreamConsumersLive = Layer.effect(
  ListStreamConsumers,
  Effect.gen(function* () {
    const Policy = yield* ListStreamConsumersPolicy;
    const listStreamConsumers = yield* Kinesis.listStreamConsumers;

    return Effect.fn(function* (stream: Stream) {
      const StreamARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request?: ListStreamConsumersRequest) {
        return yield* listStreamConsumers({
          ...request,
          StreamARN: yield* StreamARN,
        });
      });
    });
  }),
);

export class ListStreamConsumersPolicy extends Binding.Policy<
  ListStreamConsumersPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.ListStreamConsumers") {}

export const ListStreamConsumersPolicyLive =
  ListStreamConsumersPolicy.layer.succeed(
    Effect.fn(function* (host, stream) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.ListStreamConsumers(${stream}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:ListStreamConsumers"],
                Resource: [stream.streamArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `ListStreamConsumersPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
