import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetAdministratorAccount`.
 *
 * Retrieves information about the Amazon Macie administrator account for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetAdministratorAccountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Read This Account's Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAdministratorAccount = yield* AWS.Macie2.GetAdministratorAccount();
 *
 * // runtime
 * const { administrator } = yield* getAdministratorAccount();
 * ```
 */
export interface GetAdministratorAccount extends Binding.Service<
  GetAdministratorAccount,
  "AWS.Macie2.GetAdministratorAccount",
  () => Effect.Effect<
    (
      request?: macie2.GetAdministratorAccountRequest,
    ) => Effect.Effect<
      macie2.GetAdministratorAccountResponse,
      macie2.GetAdministratorAccountError
    >
  >
> {}
export const GetAdministratorAccount = Binding.Service<GetAdministratorAccount>(
  "AWS.Macie2.GetAdministratorAccount",
);
