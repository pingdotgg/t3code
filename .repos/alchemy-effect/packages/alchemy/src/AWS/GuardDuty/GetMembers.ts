import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:GetMembers`.
 *
 * Reads member account details for the given account ids; unknown accounts come back as `UnprocessedAccounts`.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Read Member Details
 * ```typescript
 * // init
 * const getMembers = yield* AWS.GuardDuty.GetMembers(detector);
 *
 * // runtime
 * const { Members, UnprocessedAccounts } = yield* getMembers({
 *   AccountIds: ["111122223333"],
 * });
 * ```
 */
export interface GetMembers extends Binding.Service<
  GetMembers,
  "AWS.GuardDuty.GetMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.GetMembersRequest, "DetectorId">,
    ) => Effect.Effect<guardduty.GetMembersResponse, guardduty.GetMembersError>
  >
> {}
export const GetMembers = Binding.Service<GetMembers>(
  "AWS.GuardDuty.GetMembers",
);
