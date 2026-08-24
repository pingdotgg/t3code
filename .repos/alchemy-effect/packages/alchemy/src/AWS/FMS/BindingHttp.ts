import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { pinFms } from "./AdminAccount.ts";

/**
 * Shared HTTP scaffolding for the AWS Firewall Manager runtime bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeFmsHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action is boilerplate.
 *
 * All Firewall Manager operations are account-level: they act on the
 * policies, lists, resource sets, and compliance data of the calling
 * (administrator) account rather than on one bound Alchemy resource, so the
 * builder grants the IAM actions on `Resource: ["*"]` and the runtime
 * callable takes the raw request.
 *
 * Policy, list, resource-set, and compliance operations are regional (a
 * Firewall Manager policy lives in the region it was created in), so they
 * resolve against the ambient region. The organization-level administrator
 * management reads (`GetAdminScope`, `ListAdminAccountsForOrganization`,
 * `ListAdminsManagingAccount`) belong to the same global admin-account
 * family as the {@link AdminAccount} resource APIs, so they are pinned to
 * the us-east-1 endpoint via {@link pinFms}.
 */
export const makeFmsHttpBinding = <I extends object, A, E, R>(options: {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"ListPolicies"`.
   */
  capability: string;
  /** IAM actions granted on `Resource: ["*"]`. */
  iamActions: readonly string[];
  /** The distilled operation implementing the capability. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /**
   * Pin the operation to the us-east-1 endpoint — set for the
   * organization-level administrator-management operations, which are
   * served from the global admin-account endpoint like the
   * {@link AdminAccount} resource APIs.
   */
  pinToAdminRegion?: boolean;
}) =>
  Effect.gen(function* () {
    const op = options.pinToAdminRegion
      ? yield* pinFms(options.operation)
      : yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.FMS.${options.capability}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.iamActions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.FMS.${options.capability}`)(function* (
        request?: I,
      ) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
