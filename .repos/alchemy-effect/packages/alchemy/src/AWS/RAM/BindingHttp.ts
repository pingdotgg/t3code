import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared HTTP scaffolding for the AWS RAM runtime bindings.
 *
 * RAM (Resource Access Manager) is an account-scoped sharing service: every
 * runtime operation targets resource shares, invitations, permissions, or
 * shared resources that are chosen per request at runtime (invitation ARNs
 * arrive from *other* accounts and are unknowable at deploy time), so every
 * binding is account-level and grants its action(s) on `Resource: ["*"]`.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeRAMHttpBinding({ … }))` over the builder below.
 * Everything except the operation and the IAM action list is boilerplate.
 */
export const makeRAMHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"GetResourceShares"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (the target shares/invitations
   * are chosen per request at runtime and unknowable at deploy time).
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
              // The target shares/invitations/permissions are chosen per
              // request at runtime.
              Resource: ["*"],
            },
          ];
          yield* host.bind`Allow(${host}, AWS.RAM.${options.capability}())`({
            policyStatements,
          });
        }
      }
      return Effect.fn(`AWS.RAM.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
