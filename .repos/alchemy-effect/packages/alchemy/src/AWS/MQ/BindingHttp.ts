import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Broker } from "./Broker.ts";

/**
 * Shared HTTP scaffolding for the Amazon MQ runtime bindings.
 *
 * Every MQ capability follows the same shape — resolve the distilled
 * operation, register an IAM policy statement on the binding host, and return
 * a runtime callable that injects the broker id. The only variation is the
 * operation, the IAM action(s), and whether the binding is scoped to one
 * broker or to the whole account, so those are the only inputs.
 *
 * @internal — not exported from `index.ts`.
 */

type MqRequirements = Credentials | Region | HttpClient.HttpClient;

export interface MqBrokerHttpBindingConfig<Req extends object, Out, Err> {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"DescribeBroker"`.
   */
  capability: string;
  /**
   * IAM actions granted to the binding host on the broker ARN, e.g.
   * `["mq:DescribeBroker"]`.
   */
  iamActions: readonly string[];
  /**
   * The distilled MQ operation implementing the capability.
   */
  operation: Effect.Effect<
    (input: Req & { BrokerId: string }) => Effect.Effect<Out, Err>,
    never,
    MqRequirements
  >;
}

/**
 * Build the implementation effect for a broker-scoped MQ capability:
 * `Layer.effect(Cap, makeMqBrokerHttpBinding({ ... }))`.
 *
 * The runtime callable injects the bound broker's id, so `Req` is the
 * operation's request type without `BrokerId`.
 */
export const makeMqBrokerHttpBinding = <Req extends object, Out, Err>(
  config: MqBrokerHttpBindingConfig<Req, Out, Err>,
) =>
  Effect.gen(function* () {
    const op = yield* config.operation;

    return Effect.fn(function* (broker: Broker) {
      const BrokerId = yield* broker.brokerId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.MQ.${config.capability}(${broker}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...config.iamActions],
                  Resource: [Output.interpolate`${broker.brokerArn}`],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.MQ.${config.capability}(${broker.LogicalId})`)(
        function* (request?: Req) {
          return yield* op({
            ...(request ?? ({} as Req)),
            BrokerId: yield* BrokerId,
          });
        },
      );
    });
  });

export interface MqAccountHttpBindingConfig<Req extends object, Out, Err> {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListBrokers"`.
   */
  capability: string;
  /**
   * IAM actions granted to the binding host on `Resource: ["*"]` (MQ
   * account-level operations are not resource-scoped).
   */
  iamActions: readonly string[];
  /**
   * The distilled MQ operation implementing the capability.
   */
  operation: Effect.Effect<
    (input: Req) => Effect.Effect<Out, Err>,
    never,
    MqRequirements
  >;
}

/**
 * Build the implementation effect for an account-level MQ capability (no
 * broker argument): `Layer.effect(Cap, makeMqAccountHttpBinding({ ... }))`.
 */
export const makeMqAccountHttpBinding = <Req extends object, Out, Err>(
  config: MqAccountHttpBindingConfig<Req, Out, Err>,
) =>
  Effect.gen(function* () {
    const op = yield* config.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.MQ.${config.capability}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...config.iamActions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.MQ.${config.capability}`)(function* (
        request?: Req,
      ) {
        return yield* op(request ?? ({} as Req));
      });
    });
  });
