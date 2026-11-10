import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
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
export const makeRoute53DomainsHttpBinding = <I extends object, A, E, R>(options: {
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
    const bind = yield* AWSBindings.Bind;
    // Capture the client with the region pinned to us-east-1 — the Route 53
    // Domains API is not served from any other region.
    const op = yield* options.operation.pipe(withRoute53DomainsRegion, AWSBindings.withCredentials);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Route53Domains.${options.capability}()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              // route53domains has no resource-level IAM
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Route53Domains.${options.capability}`)(function* (request: I) {
        // The region must also be pinned at the call site: the yield-time
        // snapshot is only a fallback — the calling fiber's ambient Region
        // (the host Function's own region) wins over it.
        return yield* withRoute53DomainsRegion(op(request));
      });
    });
  });
