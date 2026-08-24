import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListDelegatedAdministrators`.
 *
 * Lists the accounts that are designated as delegated administrators in the organization, optionally filtered by service principal.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListDelegatedAdministratorsHttp)`.
 * @binding
 * @section Delegated Administration & Trusted Access
 * @example List Delegated Administrators
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDelegatedAdministrators = yield* AWS.Organizations.ListDelegatedAdministrators();
 *
 * // runtime
 * const { DelegatedAdministrators } = yield* listDelegatedAdministrators();
 * ```
 */
export interface ListDelegatedAdministrators extends Binding.Service<
  ListDelegatedAdministrators,
  "AWS.Organizations.ListDelegatedAdministrators",
  () => Effect.Effect<
    (
      request?: organizations.ListDelegatedAdministratorsRequest,
    ) => Effect.Effect<
      organizations.ListDelegatedAdministratorsResponse,
      organizations.ListDelegatedAdministratorsError
    >
  >
> {}
export const ListDelegatedAdministrators =
  Binding.Service<ListDelegatedAdministrators>(
    "AWS.Organizations.ListDelegatedAdministrators",
  );
