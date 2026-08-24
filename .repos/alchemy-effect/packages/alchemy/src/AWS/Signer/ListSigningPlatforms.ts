import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:ListSigningPlatforms`.
 *
 * Lists the AWS-managed signing platforms (Lambda, Notation/OCI, IoT,
 * FreeRTOS, …), filterable by category, partner, and target. Account-level
 * operation over the AWS-managed platform catalog, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.Signer.ListSigningPlatformsHttp)`.
 * @binding
 * @section Discovering Platforms
 * @example Enumerate Available Platforms
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listSigningPlatforms = yield* AWS.Signer.ListSigningPlatforms();
 *
 * // runtime
 * const { platforms } = yield* listSigningPlatforms();
 * const ids = (platforms ?? []).map((p) => p.platformId);
 * ```
 */
export interface ListSigningPlatforms extends Binding.Service<
  ListSigningPlatforms,
  "AWS.Signer.ListSigningPlatforms",
  () => Effect.Effect<
    (
      request?: signer.ListSigningPlatformsRequest,
    ) => Effect.Effect<
      signer.ListSigningPlatformsResponse,
      signer.ListSigningPlatformsError
    >
  >
> {}
export const ListSigningPlatforms = Binding.Service<ListSigningPlatforms>(
  "AWS.Signer.ListSigningPlatforms",
);
