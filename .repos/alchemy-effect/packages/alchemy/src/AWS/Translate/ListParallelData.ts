import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:ListParallelData` — list the parallel data
 * resources in the account and region.
 *
 * @binding
 * @section Reading Parallel Data
 * @example List parallel data resources
 * ```typescript
 * // init
 * const listParallelData = yield* AWS.Translate.ListParallelData();
 *
 * // runtime
 * const result = yield* listParallelData({ MaxResults: 50 });
 * // result.ParallelDataPropertiesList -> [{ Name, Arn, Status, … }, …]
 * ```
 */
export interface ListParallelData extends Binding.Service<
  ListParallelData,
  "AWS.Translate.ListParallelData",
  () => Effect.Effect<
    (
      request?: translate.ListParallelDataRequest,
    ) => Effect.Effect<
      translate.ListParallelDataResponse,
      translate.ListParallelDataError
    >
  >
> {}
export const ListParallelData = Binding.Service<ListParallelData>(
  "AWS.Translate.ListParallelData",
);
