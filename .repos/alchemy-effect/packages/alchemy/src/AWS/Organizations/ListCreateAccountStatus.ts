import type * as organizations from "@distilled.cloud/aws/organizations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `organizations:ListCreateAccountStatus`.
 *
 * Lists the account-creation requests that match the specified states — auditing in-flight and completed account vending.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListCreateAccountStatusHttp)`.
 * @binding
 * @section Account Vending
 * @example List In-Flight Account Creations
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listCreateAccountStatus = yield* AWS.Organizations.ListCreateAccountStatus();
 *
 * // runtime
 * const { CreateAccountStatuses } = yield* listCreateAccountStatus({
 *   States: ["IN_PROGRESS"],
 * });
 * ```
 */
export interface ListCreateAccountStatus extends Binding.Service<
  ListCreateAccountStatus,
  "AWS.Organizations.ListCreateAccountStatus",
  () => Effect.Effect<
    (
      request?: organizations.ListCreateAccountStatusRequest,
    ) => Effect.Effect<
      organizations.ListCreateAccountStatusResponse,
      organizations.ListCreateAccountStatusError
    >
  >
> {}
export const ListCreateAccountStatus = Binding.Service<ListCreateAccountStatus>(
  "AWS.Organizations.ListCreateAccountStatus",
);
