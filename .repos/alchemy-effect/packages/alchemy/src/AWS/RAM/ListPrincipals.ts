import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListPrincipals`.
 *
 * Lists the principals that you are sharing resources with or that are sharing resources with you.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListPrincipalsHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example List the Principals You Share With
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPrincipals = yield* AWS.RAM.ListPrincipals();
 *
 * // runtime
 * const { principals } = yield* listPrincipals({ resourceOwner: "SELF" });
 * ```
 */
export interface ListPrincipals extends Binding.Service<
  ListPrincipals,
  "AWS.RAM.ListPrincipals",
  () => Effect.Effect<
    (
      request: ram.ListPrincipalsRequest,
    ) => Effect.Effect<ram.ListPrincipalsResponse, ram.ListPrincipalsError>
  >
> {}
export const ListPrincipals = Binding.Service<ListPrincipals>(
  "AWS.RAM.ListPrincipals",
);
