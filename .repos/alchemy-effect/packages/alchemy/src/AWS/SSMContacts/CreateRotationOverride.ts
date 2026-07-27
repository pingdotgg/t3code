import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Runtime binding for `ssm-contacts:CreateRotationOverride`.
 *
 * Temporarily override who is on call in the bound rotation — e.g. cover
 * a shift while the scheduled contact is unavailable. The rotation's ARN
 * is injected as `RotationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.CreateRotationOverrideHttp)`.
 * @binding
 * @section Managing On-Call Rotations
 * @example Cover the Next Eight Hours
 * ```typescript
 * const createRotationOverride =
 *   yield* AWS.SSMContacts.CreateRotationOverride(rotation);
 *
 * const { RotationOverrideId } = yield* createRotationOverride({
 *   NewContactIds: [standbyContactArn],
 *   StartTime: new Date(),
 *   EndTime: new Date(Date.now() + 8 * 60 * 60 * 1000),
 * });
 * ```
 */
export interface CreateRotationOverride extends Binding.Service<
  CreateRotationOverride,
  "AWS.SSMContacts.CreateRotationOverride",
  (
    rotation: Rotation,
  ) => Effect.Effect<
    (
      request: Omit<ssm.CreateRotationOverrideRequest, "RotationId">,
    ) => Effect.Effect<
      ssm.CreateRotationOverrideResult,
      ssm.CreateRotationOverrideError
    >
  >
> {}
export const CreateRotationOverride = Binding.Service<CreateRotationOverride>(
  "AWS.SSMContacts.CreateRotationOverride",
);
