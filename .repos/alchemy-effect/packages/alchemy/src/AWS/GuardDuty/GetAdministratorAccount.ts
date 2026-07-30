import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetAdministratorAccount`.
 *
 * Reads the administrator account managing this detector (empty relationship for a standalone account).
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetAdministratorAccountHttp)`.
 * @binding
 * @section Administrator & Invitations
 * @example Read the Administrator
 * ```typescript
 * // init
 * const getAdministratorAccount = yield* AWS.GuardDuty.GetAdministratorAccount(detector);
 *
 * // runtime
 * const { Administrator } = yield* getAdministratorAccount();
 * ```
 */
export interface GetAdministratorAccount extends Binding.Service<
  GetAdministratorAccount,
  "AWS.GuardDuty.GetAdministratorAccount",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetAdministratorAccountRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.GetAdministratorAccountResponse,
      guardduty.GetAdministratorAccountError
    >
  >
> {}
export const GetAdministratorAccount = Binding.Service<GetAdministratorAccount>(
  "AWS.GuardDuty.GetAdministratorAccount",
);
