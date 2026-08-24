import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:CreateMembers`.
 *
 * Associates member accounts with this administrator detector (organization-managed or invitation flow).
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.CreateMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example Add a Member Account
 * ```typescript
 * // init
 * const createMembers = yield* AWS.GuardDuty.CreateMembers(detector);
 *
 * // runtime
 * yield* createMembers({
 *   AccountDetails: [{ AccountId: "111122223333", Email: "security@example.com" }],
 * });
 * ```
 */
export interface CreateMembers extends Binding.Service<
  CreateMembers,
  "AWS.GuardDuty.CreateMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.CreateMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.CreateMembersResponse,
      guardduty.CreateMembersError
    >
  >
> {}
export const CreateMembers = Binding.Service<CreateMembers>(
  "AWS.GuardDuty.CreateMembers",
);
