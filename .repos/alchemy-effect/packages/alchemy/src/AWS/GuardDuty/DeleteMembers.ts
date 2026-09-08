import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:DeleteMembers`.
 *
 * Deletes member accounts from this administrator detector entirely.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.DeleteMembersHttp)`.
 * ### Member Administration
 * **Example:** Delete Members
 * ```typescript
 * // init
 * const deleteMembers = yield* AWS.GuardDuty.DeleteMembers(detector);
 *
 * // runtime
 * yield* deleteMembers({ AccountIds: ["111122223333"] });
 * ```
 *
 * @binding
 */
export interface DeleteMembers extends Binding.Service<
  DeleteMembers,
  "AWS.GuardDuty.DeleteMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.DeleteMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.DeleteMembersResponse,
      guardduty.DeleteMembersError
    >
  >
> {}
export const DeleteMembers = Binding.Service<DeleteMembers>(
  "AWS.GuardDuty.DeleteMembers",
);
