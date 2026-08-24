import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartProjectVersion` — start hosting a trained Custom Labels model version so it can serve DetectCustomLabels requests.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartProjectVersion` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartProjectVersionHttp)`.
 *
 * @binding
 * @section Custom Labels
 * @example Start a Model Version
 * ```typescript
 * // init
 * const startProjectVersion = yield* AWS.Rekognition.StartProjectVersion();
 *
 * // runtime
 * const started = yield* startProjectVersion({
 *   ProjectVersionArn: modelArn,
 *   MinInferenceUnits: 1,
 * });
 * // started.Status
 * ```
 */
export interface StartProjectVersion extends Binding.Service<
  StartProjectVersion,
  "AWS.Rekognition.StartProjectVersion",
  () => Effect.Effect<
    (
      request: rekognition.StartProjectVersionRequest,
    ) => Effect.Effect<
      rekognition.StartProjectVersionResponse,
      rekognition.StartProjectVersionError
    >
  >
> {}
export const StartProjectVersion = Binding.Service<StartProjectVersion>(
  "AWS.Rekognition.StartProjectVersion",
);
