import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";

/**
 * Shared HTTP scaffolding for the Lake Formation runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeLakeFormationHttpBinding({ … }))` over the
 * builder below. Everything except the operation and the IAM action list is
 * boilerplate.
 *
 * Per the `lakeformation` service authorization reference, Lake Formation
 * IAM actions support no resource types (authorization beyond IAM is
 * enforced by Lake Formation's own permission grants — see
 * `AWS.LakeFormation.Permissions`), so every binding grants its actions on
 * `Resource: ["*"]`.
 */
export const makeLakeFormationHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetDataLakePrincipal"`.
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
        yield* bind`AWS.LakeFormation.${options.capability}()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.iamActions],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.LakeFormation.${options.capability}`)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
