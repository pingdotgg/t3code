import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListHandshakesForAccount`.
 *
 * Lists the handshakes that are associated with the calling account — pending and recently concluded invitations.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListHandshakesForAccountHttp)`.
 * @binding
 * @section Handshakes & Invitations
 * @example List the Account's Handshakes
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listHandshakesForAccount = yield* AWS.Organizations.ListHandshakesForAccount();
 *
 * // runtime
 * const { Handshakes } = yield* listHandshakesForAccount();
 * ```
 */
export interface ListHandshakesForAccount extends Binding.Service<
  ListHandshakesForAccount,
  "AWS.Organizations.ListHandshakesForAccount",
  () => Effect.Effect<
    (
      request?: organizations.ListHandshakesForAccountRequest,
    ) => Effect.Effect<
      organizations.ListHandshakesForAccountResponse,
      organizations.ListHandshakesForAccountError
    >
  >
> {}
export const ListHandshakesForAccount =
  Binding.Service<ListHandshakesForAccount>(
    "AWS.Organizations.ListHandshakesForAccount",
  );
