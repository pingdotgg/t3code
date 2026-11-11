import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";

/**
 * Shared HTTP scaffolding for the Service Quotas runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeServiceQuotasHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action is
 * boilerplate.
 *
 * Service Quotas is a control-plane query service: none of its actions
 * support resource-level IAM in a way a deploy-time binding could scope
 * (quota codes are supplied at runtime), so every grant is on
 * `Resource: ["*"]` and every binding is account-level (takes no resource).
 */
export const makeServiceQuotasHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetServiceQuota"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ServiceQuotas.${options.capability}()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              // Service Quotas actions have no deploy-time scopeable
              // resource — quota ARNs are only known at runtime.
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.ServiceQuotas.${options.capability}`)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
