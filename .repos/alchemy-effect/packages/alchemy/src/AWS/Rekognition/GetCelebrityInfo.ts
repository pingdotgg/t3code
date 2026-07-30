import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetCelebrityInfo` — get the name and additional links for a celebrity ID returned by RecognizeCelebrities.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetCelebrityInfo` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetCelebrityInfoHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Look Up a Celebrity by ID
 * ```typescript
 * // init
 * const getCelebrityInfo = yield* AWS.Rekognition.GetCelebrityInfo();
 *
 * // runtime
 * const info = yield* getCelebrityInfo({ Id: celebrityId });
 * // info.Name, info.Urls, info.KnownGender
 * ```
 */
export interface GetCelebrityInfo extends Binding.Service<
  GetCelebrityInfo,
  "AWS.Rekognition.GetCelebrityInfo",
  () => Effect.Effect<
    (
      request: rekognition.GetCelebrityInfoRequest,
    ) => Effect.Effect<
      rekognition.GetCelebrityInfoResponse,
      rekognition.GetCelebrityInfoError
    >
  >
> {}
export const GetCelebrityInfo = Binding.Service<GetCelebrityInfo>(
  "AWS.Rekognition.GetCelebrityInfo",
);
