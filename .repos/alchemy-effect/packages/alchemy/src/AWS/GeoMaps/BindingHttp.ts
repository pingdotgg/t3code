import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the geo-maps runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeGeoMapsHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action is boilerplate.
 *
 * geo-maps is a standalone, pay-per-call Amazon Location API with no
 * resource to manage: every capability takes no arguments, and per the
 * `geo-maps` service authorization reference all actions authorize through
 * the singleton `provider/default` pseudo-resource, so grants use
 * `Resource: ["*"]`.
 */
export const makeGeoMapsHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetStaticMap"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.GeoMaps.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.GeoMaps.${options.capability}`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
