import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetFaceSearch` — get the results of an asynchronous video face search started by StartFaceSearch.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetFaceSearch` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetFaceSearchHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Face Search Results
 * ```typescript
 * // init
 * const getFaceSearch = yield* AWS.Rekognition.GetFaceSearch();
 *
 * // runtime
 * const results = yield* getFaceSearch({ JobId: jobId });
 * const persons = results.Persons ?? [];
 * ```
 */
export interface GetFaceSearch extends Binding.Service<
  GetFaceSearch,
  "AWS.Rekognition.GetFaceSearch",
  () => Effect.Effect<
    (
      request: rekognition.GetFaceSearchRequest,
    ) => Effect.Effect<
      rekognition.GetFaceSearchResponse,
      rekognition.GetFaceSearchError
    >
  >
> {}
export const GetFaceSearch = Binding.Service<GetFaceSearch>(
  "AWS.Rekognition.GetFaceSearch",
);
