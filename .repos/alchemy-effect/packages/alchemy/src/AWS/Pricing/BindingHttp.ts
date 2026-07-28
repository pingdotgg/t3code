import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { withPricingRegion } from "./internal.ts";

/**
 * Shared HTTP scaffolding for the AWS Price List runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makePricingHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action is boilerplate.
 *
 * The Price List Query API is a global, data-only service served from
 * `us-east-1` (and `ap-south-1`) only, so every operation is resolved with
 * the Region pinned via {@link withPricingRegion}. None of the `pricing:*`
 * actions support resource-level IAM, so every grant is on
 * `Resource: ["*"]`.
 */
export const makePricingHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetProducts"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]` (no resource-level IAM). */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Price
    // List Query API is not served from most regions.
    const op = yield* withPricingRegion(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Pricing.${options.capability}())`(
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
      return Effect.fn(`AWS.Pricing.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
