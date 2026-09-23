import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:GetParallelData` — retrieve a parallel
 * data resource's properties and a presigned download location for its
 * input file.
 *
 * ### Reading Parallel Data
 * **Example:** Read a parallel data resource
 * ```typescript
 * // init
 * const getParallelData = yield* AWS.Translate.GetParallelData();
 *
 * // runtime
 * const result = yield* getParallelData({ Name: examples.parallelDataName });
 * // result.ParallelDataProperties?.Status === "ACTIVE"
 * ```
 *
 * @binding
 */
export interface GetParallelData extends Binding.Service<
  GetParallelData,
  "AWS.Translate.GetParallelData",
  () => Effect.Effect<
    (
      request: translate.GetParallelDataRequest,
    ) => Effect.Effect<
      translate.GetParallelDataResponse,
      translate.GetParallelDataError
    >
  >
> {}
export const GetParallelData = Binding.Service<GetParallelData>(
  "AWS.Translate.GetParallelData",
);
