import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Stream } from "./Stream.ts";

export interface GetResourcePolicyRequest extends Omit<
  Kinesis.GetResourcePolicyInput,
  "ResourceARN"
> {}

export class GetResourcePolicy extends Binding.Service<
  GetResourcePolicy,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: GetResourcePolicyRequest,
    ) => Effect.Effect<
      Kinesis.GetResourcePolicyOutput,
      Kinesis.GetResourcePolicyError
    >
  >
>()("AWS.Kinesis.GetResourcePolicy") {}

export const GetResourcePolicyLive = Layer.effect(
  GetResourcePolicy,
  Effect.gen(function* () {
    const Policy = yield* GetResourcePolicyPolicy;
    const getResourcePolicy = yield* Kinesis.getResourcePolicy;

    return Effect.fn(function* (stream: Stream) {
      const ResourceARN = yield* stream.streamArn;
      yield* Policy(stream);
      return Effect.fn(function* (request?: GetResourcePolicyRequest) {
        return yield* getResourcePolicy({
          ...request,
          ResourceARN: yield* ResourceARN,
        });
      });
    });
  }),
);

export class GetResourcePolicyPolicy extends Binding.Policy<
  GetResourcePolicyPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.GetResourcePolicy") {}

export const GetResourcePolicyPolicyLive =
  GetResourcePolicyPolicy.layer.succeed(
    Effect.fn(function* (host, stream) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.GetResourcePolicy(${stream}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:GetResourcePolicy"],
                Resource: [stream.streamArn],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `GetResourcePolicyPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
