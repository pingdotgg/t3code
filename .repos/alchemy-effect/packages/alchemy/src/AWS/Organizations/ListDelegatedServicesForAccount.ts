import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListDelegatedServicesForAccount`.
 *
 * Lists the Amazon Web Services services for which the specified account is a delegated administrator.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListDelegatedServicesForAccountHttp)`.
 * @binding
 * @section Delegated Administration & Trusted Access
 * @example List an Account's Delegated Services
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDelegatedServicesForAccount = yield* AWS.Organizations.ListDelegatedServicesForAccount();
 *
 * // runtime
 * const { DelegatedServices } = yield* listDelegatedServicesForAccount({
 *   AccountId: accountId,
 * });
 * ```
 */
export interface ListDelegatedServicesForAccount extends Binding.Service<
  ListDelegatedServicesForAccount,
  "AWS.Organizations.ListDelegatedServicesForAccount",
  () => Effect.Effect<
    (
      request: organizations.ListDelegatedServicesForAccountRequest,
    ) => Effect.Effect<
      organizations.ListDelegatedServicesForAccountResponse,
      organizations.ListDelegatedServicesForAccountError
    >
  >
> {}
export const ListDelegatedServicesForAccount =
  Binding.Service<ListDelegatedServicesForAccount>(
    "AWS.Organizations.ListDelegatedServicesForAccount",
  );
