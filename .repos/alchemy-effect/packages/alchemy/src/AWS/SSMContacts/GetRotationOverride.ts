import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Runtime binding for `ssm-contacts:GetRotationOverride`.
 *
 * Read a rotation override of the bound rotation — its replacement
 * contacts and time window. The rotation's ARN is injected as
 * `RotationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.GetRotationOverrideHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example Inspect an Override
 * ```typescript
 * const getRotationOverride = yield* AWS.SSMContacts.GetRotationOverride(rotation);
 *
 * const override = yield* getRotationOverride({
 *   RotationOverrideId: overrideId,
 * });
 * ```
 */
export interface GetRotationOverride extends Binding.Service<
  GetRotationOverride,
  "AWS.SSMContacts.GetRotationOverride",
  (
    rotation: Rotation,
  ) => Effect.Effect<
    (
      request: Omit<ssm.GetRotationOverrideRequest, "RotationId">,
    ) => Effect.Effect<
      ssm.GetRotationOverrideResult,
      ssm.GetRotationOverrideError
    >
  >
> {}
export const GetRotationOverride = Binding.Service<GetRotationOverride>(
  "AWS.SSMContacts.GetRotationOverride",
);
