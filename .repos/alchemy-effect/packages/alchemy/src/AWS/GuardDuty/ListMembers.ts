import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Detector } from "./Detector.ts";

/**
 * Runtime binding for `guardduty:ListMembers`.
 *
 * Enumerates the member accounts associated with this administrator detector.
 * The detector id is injected from the bound {@link Detector}.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.ListMembersHttp)`.
 * @binding
 * @section Member Administration
 * @example List Member Accounts
 * ```typescript
 * // init
 * const listMembers = yield* AWS.GuardDuty.ListMembers(detector);
 *
 * // runtime
 * const { Members } = yield* listMembers();
 * ```
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.GuardDuty.ListMembers",
  (
    detector: Detector,
  ) => Effect.Effect<
    (
      request?: Omit<guardduty.ListMembersRequest, "DetectorId">,
    ) => Effect.Effect<
      guardduty.ListMembersResponse,
      guardduty.ListMembersError
    >
  >
> {}
export const ListMembers = Binding.Service<ListMembers>(
  "AWS.GuardDuty.ListMembers",
);
