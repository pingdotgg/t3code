import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectProtectiveEquipment` — detect personal protective equipment (face covers, hand covers, head covers) worn by persons in an image.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DetectProtectiveEquipment` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DetectProtectiveEquipmentHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Check for Face Covers
 * ```typescript
 * // init
 * const detectProtectiveEquipment = yield* AWS.Rekognition.DetectProtectiveEquipment();
 *
 * // runtime
 * const result = yield* detectProtectiveEquipment({
 *   Image: { Bytes: imageBytes },
 *   SummarizationAttributes: {
 *     MinConfidence: 80,
 *     RequiredEquipmentTypes: ["FACE_COVER"],
 *   },
 * });
 * ```
 */
export interface DetectProtectiveEquipment extends Binding.Service<
  DetectProtectiveEquipment,
  "AWS.Rekognition.DetectProtectiveEquipment",
  () => Effect.Effect<
    (
      request: rekognition.DetectProtectiveEquipmentRequest,
    ) => Effect.Effect<
      rekognition.DetectProtectiveEquipmentResponse,
      rekognition.DetectProtectiveEquipmentError
    >
  >
> {}
export const DetectProtectiveEquipment =
  Binding.Service<DetectProtectiveEquipment>(
    "AWS.Rekognition.DetectProtectiveEquipment",
  );
