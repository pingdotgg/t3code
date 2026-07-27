import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Runtime binding for `ssm-contacts:ListRotationOverrides`.
 *
 * List the rotation overrides of the bound rotation in a time window.
 * The rotation's ARN is injected as `RotationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ListRotationOverridesHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example List Overrides This Week
 * ```typescript
 * const listRotationOverrides =
 *   yield* AWS.SSMContacts.ListRotationOverrides(rotation);
 *
 * const { RotationOverrides } = yield* listRotationOverrides({
 *   StartTime: new Date(),
 *   EndTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 * });
 * ```
 */
export interface ListRotationOverrides extends Binding.Service<
  ListRotationOverrides,
  "AWS.SSMContacts.ListRotationOverrides",
  (
    rotation: Rotation,
  ) => Effect.Effect<
    (
      request: Omit<ssm.ListRotationOverridesRequest, "RotationId">,
    ) => Effect.Effect<
      ssm.ListRotationOverridesResult,
      ssm.ListRotationOverridesError
    >
  >
> {}
export const ListRotationOverrides = Binding.Service<ListRotationOverrides>(
  "AWS.SSMContacts.ListRotationOverrides",
);
