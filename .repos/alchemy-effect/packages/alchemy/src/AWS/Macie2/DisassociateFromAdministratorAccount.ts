import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DisassociateFromAdministratorAccount`.
 *
 * Disassociates a member account from its Amazon Macie administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DisassociateFromAdministratorAccountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Leave the Administrator Account
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateFromAdministratorAccount = yield* AWS.Macie2.DisassociateFromAdministratorAccount();
 *
 * // runtime
 * yield* disassociateFromAdministratorAccount();
 * ```
 */
export interface DisassociateFromAdministratorAccount extends Binding.Service<
  DisassociateFromAdministratorAccount,
  "AWS.Macie2.DisassociateFromAdministratorAccount",
  () => Effect.Effect<
    (
      request: macie2.DisassociateFromAdministratorAccountRequest,
    ) => Effect.Effect<
      macie2.DisassociateFromAdministratorAccountResponse,
      macie2.DisassociateFromAdministratorAccountError
    >
  >
> {}
export const DisassociateFromAdministratorAccount =
  Binding.Service<DisassociateFromAdministratorAccount>(
    "AWS.Macie2.DisassociateFromAdministratorAccount",
  );
