import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

/**
 * Shared HTTP scaffolding for the AWS Organizations runtime bindings.
 *
 * Organizations is a management-account-scoped global service: every runtime
 * operation targets the caller's organization or entities within it (roots,
 * OUs, accounts, policies, handshakes) that are chosen per request at
 * runtime, so every binding is account-level and grants its action(s) on
 * `Resource: ["*"]`.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeOrganizationsHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */
export const makeOrganizationsHttpBinding = <I, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListAccounts"`.
   */
  capability: string;
  /**
   * IAM actions granted on `Resource: ["*"]` (the target organization
   * entities are chosen per request at runtime and unknowable at deploy
   * time).
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
              // The target organization entities are chosen per request at
              // runtime.
              Resource: ["*"],
            },
          ];
          yield* host.bind`Allow(${host}, AWS.Organizations.${options.capability}())`(
            {
              policyStatements,
            },
          );
        }
      }
      return Effect.fn(`AWS.Organizations.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
