import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface ListStreamsRequest extends Kinesis.ListStreamsInput {}

export class ListStreams extends Binding.Service<
  ListStreams,
  () => Effect.Effect<
    (
      request?: ListStreamsRequest,
    ) => Effect.Effect<Kinesis.ListStreamsOutput, Kinesis.ListStreamsError>
  >
>()("AWS.Kinesis.ListStreams") {}

export const ListStreamsLive = Layer.effect(
  ListStreams,
  Effect.gen(function* () {
    const Policy = yield* ListStreamsPolicy;
    const listStreams = yield* Kinesis.listStreams;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: ListStreamsRequest) {
        return yield* listStreams(request ?? {});
      });
    });
  }),
);

export class ListStreamsPolicy extends Binding.Policy<
  ListStreamsPolicy,
  () => Effect.Effect<void>
>()("AWS.Kinesis.ListStreams") {}

export const ListStreamsPolicyLive = ListStreamsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.ListStreams())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:ListStreams"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `ListStreamsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
