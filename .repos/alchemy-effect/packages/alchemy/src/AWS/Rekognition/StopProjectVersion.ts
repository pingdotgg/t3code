import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StopProjectVersion` — stop hosting a Custom Labels model version to stop incurring inference-unit charges.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StopProjectVersion` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StopProjectVersionHttp)`.
 *
 * @binding
 * @section Custom Labels
 * @example Stop a Model Version
 * ```typescript
 * // init
 * const stopProjectVersion = yield* AWS.Rekognition.StopProjectVersion();
 *
 * // runtime
 * const stopped = yield* stopProjectVersion({ ProjectVersionArn: modelArn });
 * // stopped.Status
 * ```
 */
export interface StopProjectVersion extends Binding.Service<
  StopProjectVersion,
  "AWS.Rekognition.StopProjectVersion",
  () => Effect.Effect<
    (
      request: rekognition.StopProjectVersionRequest,
    ) => Effect.Effect<
      rekognition.StopProjectVersionResponse,
      rekognition.StopProjectVersionError
    >
  >
> {}
export const StopProjectVersion = Binding.Service<StopProjectVersion>(
  "AWS.Rekognition.StopProjectVersion",
);
