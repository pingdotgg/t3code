import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { withRoute53DomainsRegion } from "./internal.ts";

/**
 * Shared HTTP scaffolding for the Route 53 Domains runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeRoute53DomainsHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action is
 * boilerplate.
 *
 * Route 53 Domains is a global registration API with no resource-level IAM:
 * every action authorizes account-wide, so the builder always grants on
 * `Resource: ["*"]` and the capability takes no arguments. The API is only
 * served from `us-east-1`, so the captured client is pinned to that region
 * regardless of where the calling function runs.
 */
export const makeRoute53DomainsHttpBinding = <
  I extends object,
  A,
  E,
  R,
>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"CheckDomainAvailability"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    // Capture the client with the region pinned to us-east-1 — the Route 53
    // Domains API is not served from any other region.
    const op = yield* withRoute53DomainsRegion(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Route53Domains.${options.capability}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.iamActions],
                  // route53domains has no resource-level IAM
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Route53Domains.${options.capability}`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
