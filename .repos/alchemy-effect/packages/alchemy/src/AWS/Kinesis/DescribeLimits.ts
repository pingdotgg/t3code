import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeLimitsRequest extends Kinesis.DescribeLimitsInput {}

export class DescribeLimits extends Binding.Service<
  DescribeLimits,
  () => Effect.Effect<
    (
      request?: DescribeLimitsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeLimitsOutput,
      Kinesis.DescribeLimitsError
    >
  >
>()("AWS.Kinesis.DescribeLimits") {}

export const DescribeLimitsLive = Layer.effect(
  DescribeLimits,
  Effect.gen(function* () {
    const Policy = yield* DescribeLimitsPolicy;
    const describeLimits = yield* Kinesis.describeLimits;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: DescribeLimitsRequest) {
        return yield* describeLimits(request ?? {});
      });
    });
  }),
);

export class DescribeLimitsPolicy extends Binding.Policy<
  DescribeLimitsPolicy,
  () => Effect.Effect<void>
>()("AWS.Kinesis.DescribeLimits") {}

export const DescribeLimitsPolicyLive = DescribeLimitsPolicy.layer.succeed(
  Effect.fn(function* (host) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeLimits())`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["kinesis:DescribeLimits"],
            Resource: ["*"],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DescribeLimitsPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
