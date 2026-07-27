import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:DisassociateMembers`.
 *
 * Disassociates member accounts from this administrator detector without deleting them.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DisassociateMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Disassociate Members
 * ```typescript
 * // init
 * const disassociateMembers = yield* AWS.GuardDuty.DisassociateMembers(detector);
 *
 * // runtime
 * yield* disassociateMembers({ AccountIds: ["111122223333"] });
 * ```
 */
export interface DisassociateMembers extends Binding.Service<
  DisassociateMembers,
  "AWS.GuardDuty.DisassociateMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.DisassociateMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.DisassociateMembersResponse,
      guardduty.DisassociateMembersError
    >
  >
> {}
export const DisassociateMembers = Binding.Service<DisassociateMembers>(
  "AWS.GuardDuty.DisassociateMembers",
);
