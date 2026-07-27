import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the AWS Service Catalog runtime bindings.
 *
 * Service Catalog's end-user (self-service) plane is account-scoped:
 * which products a caller can see and launch is governed by portfolio
 * principal associations, not by IAM resource ARNs, and the target
 * products / provisioned products are discovered per request at runtime
 * (`searchProducts`, `searchProvisionedProducts`). Every binding is
 * therefore account-level and grants its action(s) on `Resource: ["*"]`.
 *
 * The provisioning writes (`ProvisionProduct`, `UpdateProvisionedProduct`,
 * `TerminateProvisionedProduct`) additionally grant the CloudFormation
 * (and template-fetch `s3:GetObject`) actions Service Catalog performs
 * with the caller's credentials when the product has no launch-role
 * constraint.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service
 * is a `Layer.effect(Cap, makeServiceCatalogHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action list
 * is boilerplate.
 */
export const makeServiceCatalogHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"SearchProducts"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (access is governed by
   * portfolio principal associations; targets are chosen per request).
   */
  iamActions: readonly string[];
  /**
   * The distilled operation implementing the capability.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const policyStatements: PolicyStatement[] = [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              // Access is governed by portfolio principal associations;
              // the target products / provisioned products are chosen per
              // request at runtime.
              Resource: ["*"],
            },
          ];
          yield* host.bind`Allow(${host}, AWS.ServiceCatalog.${options.capability}())`(
            {
              policyStatements,
            },
          );
        }
      }
      return Effect.fn(`AWS.ServiceCatalog.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
