import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";

export interface DescribeAccountSettingsRequest
  extends Kinesis.DescribeAccountSettingsInput {}

export class DescribeAccountSettings extends Binding.Service<
  DescribeAccountSettings,
  () => Effect.Effect<
    (
      request?: DescribeAccountSettingsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeAccountSettingsOutput,
      Kinesis.DescribeAccountSettingsError
    >
  >
>()("AWS.Kinesis.DescribeAccountSettings") {}

export const DescribeAccountSettingsLive = Layer.effect(
  DescribeAccountSettings,
  Effect.gen(function* () {
    const Policy = yield* DescribeAccountSettingsPolicy;
    const describeAccountSettings = yield* Kinesis.describeAccountSettings;

    return Effect.fn(function* () {
      yield* Policy();
      return Effect.fn(function* (request?: DescribeAccountSettingsRequest) {
        return yield* describeAccountSettings(request ?? {});
      });
    });
  }),
);

export class DescribeAccountSettingsPolicy extends Binding.Policy<
  DescribeAccountSettingsPolicy,
  () => Effect.Effect<void>
>()("AWS.Kinesis.DescribeAccountSettings") {}

export const DescribeAccountSettingsPolicyLive =
  DescribeAccountSettingsPolicy.layer.succeed(
    Effect.fn(function* (host) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.Kinesis.DescribeAccountSettings())`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["kinesis:DescribeAccountSettings"],
                Resource: ["*"],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `DescribeAccountSettingsPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
