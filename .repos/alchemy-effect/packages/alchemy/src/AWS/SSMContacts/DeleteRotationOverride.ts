import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Runtime binding for `ssm-contacts:DeleteRotationOverride`.
 *
 * Delete a rotation override of the bound rotation, restoring the
 * regular schedule. The rotation's ARN is injected as `RotationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.DeleteRotationOverrideHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example Remove an Override
 * ```typescript
 * const deleteRotationOverride =
 *   yield* AWS.SSMContacts.DeleteRotationOverride(rotation);
 *
 * yield* deleteRotationOverride({ RotationOverrideId: overrideId });
 * ```
 */
export interface DeleteRotationOverride extends Binding.Service<
  DeleteRotationOverride,
  "AWS.SSMContacts.DeleteRotationOverride",
  (
    rotation: Rotation,
  ) => Effect.Effect<
    (
      request: Omit<ssm.DeleteRotationOverrideRequest, "RotationId">,
    ) => Effect.Effect<
      ssm.DeleteRotationOverrideResult,
      ssm.DeleteRotationOverrideError
    >
  >
> {}
export const DeleteRotationOverride = Binding.Service<DeleteRotationOverride>(
  "AWS.SSMContacts.DeleteRotationOverride",
);
