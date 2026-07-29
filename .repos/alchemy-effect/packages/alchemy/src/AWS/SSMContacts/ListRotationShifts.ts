import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Runtime binding for `ssm-contacts:ListRotationShifts`.
 *
 * List the bound rotation's shifts in a time window — who is (or will
 * be) on call and when. The rotation's ARN is injected as `RotationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListRotationShiftsHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example Who Is On Call This Week
 * ```typescript
 * const listRotationShifts = yield* AWS.SSMContacts.ListRotationShifts(rotation);
 *
 * const { RotationShifts } = yield* listRotationShifts({
 *   EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 * });
 * ```
 */
export interface ListRotationShifts extends Binding.Service<
  ListRotationShifts,
  "AWS.SSMContacts.ListRotationShifts",
  (
    rotation: Rotation,
  ) => Effect.Effect<
    (
      request: Omit<ssm.ListRotationShiftsRequest, "RotationId">,
    ) => Effect.Effect<
      ssm.ListRotationShiftsResult,
      ssm.ListRotationShiftsError
    >
  >
> {}
export const ListRotationShifts = Binding.Service<ListRotationShifts>(
  "AWS.SSMContacts.ListRotationShifts",
);
