import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:DisassociateFromAdministratorAccount`.
 *
 * Disassociates this member detector from its administrator account.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DisassociateFromAdministratorAccountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Leave the Administrator
 * ```typescript
 * // init
 * const disassociateFromAdministratorAccount = yield* AWS.GuardDuty.DisassociateFromAdministratorAccount(detector);
 *
 * // runtime
 * yield* disassociateFromAdministratorAccount();
 * ```
 */
export interface DisassociateFromAdministratorAccount extends Binding.Service<
  DisassociateFromAdministratorAccount,
  "AWS.GuardDuty.DisassociateFromAdministratorAccount",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<
        guardduty.DisassociateFromAdministratorAccountRequest,
        "DetectorId"
      >,
    ) => Effect.Effect<
      guardduty.DisassociateFromAdministratorAccountResponse,
      guardduty.DisassociateFromAdministratorAccountError
    >
  >
> {}
export const DisassociateFromAdministratorAccount =
  Binding.Service<DisassociateFromAdministratorAccount>(
    "AWS.GuardDuty.DisassociateFromAdministratorAccount",
  );
