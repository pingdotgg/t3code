import type * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `macie2:GetAdministratorAccount`.
 *
 * Retrieves information about the Amazon Macie administrator account for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetAdministratorAccountHttp)`.
 * ### Administrator & Invitations
 * **Example:** Read This Account's Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getAdministratorAccount = yield* AWS.Macie2.GetAdministratorAccount();
 *
 * // runtime
 * const { administrator } = yield* getAdministratorAccount();
 * ```
 *
 * @binding
 */
export interface GetAdministratorAccount extends Binding.Service<
  GetAdministratorAccount,
  "AWS.Macie2.GetAdministratorAccount",
  () => Effect.Effect<
    (
      request?: macie2.GetAdministratorAccountRequest,
    ) => Effect.Effect<macie2.GetAdministratorAccountResponse, macie2.GetAdministratorAccountError>
  >
> {}
export const GetAdministratorAccount = Binding.Service<GetAdministratorAccount>(
  "AWS.Macie2.GetAdministratorAccount",
);
