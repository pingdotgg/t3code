import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DisassociateFromAdministratorAccount`.
 *
 * Disassociates this member account from its Security Hub administrator account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DisassociateFromAdministratorAccountHttp)`.
 * @binding
 * @section Members & Organization
 * @example Leave the Administrator
 * ```typescript
 * // init — account-level binding, no resource argument
 * const disassociateFromAdministratorAccount = yield* AWS.SecurityHub.DisassociateFromAdministratorAccount();
 *
 * // runtime
 * yield* disassociateFromAdministratorAccount();
 * ```
 */
export interface DisassociateFromAdministratorAccount extends Binding.Service<
  DisassociateFromAdministratorAccount,
  "AWS.SecurityHub.DisassociateFromAdministratorAccount",
  () => Effect.Effect<
    (
      request?: securityhub.DisassociateFromAdministratorAccountRequest,
    ) => Effect.Effect<
      securityhub.DisassociateFromAdministratorAccountResponse,
      securityhub.DisassociateFromAdministratorAccountError
    >
  >
> {}
export const DisassociateFromAdministratorAccount =
  Binding.Service<DisassociateFromAdministratorAccount>(
    "AWS.SecurityHub.DisassociateFromAdministratorAccount",
  );
