import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetCostCategories}.
 */
export interface GetCostCategoriesRequest extends ce.GetCostCategoriesRequest {}

/**
 * Runtime binding for `ce:GetCostCategories`.
 *
 * Retrieve the cost category names (or the values of one category)
 * present in your cost data — usable in query filter expressions. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetCostCategoriesHttp)`.
 * @binding
 * @section Exploring Dimensions and Tags
 * @example List Cost Category Names and Values
 * ```typescript
 * // init — account-level binding takes no resource
 * const getCostCategories = yield* AWS.CostExplorer.GetCostCategories();
 *
 * // runtime
 * const result = yield* getCostCategories({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 * });
 * const names = result.CostCategoryNames;
 * ```
 */
export interface GetCostCategories extends Binding.Service<
  GetCostCategories,
  "AWS.CostExplorer.GetCostCategories",
  () => Effect.Effect<
    (
      request: GetCostCategoriesRequest,
    ) => Effect.Effect<ce.GetCostCategoriesResponse, ce.GetCostCategoriesError>
  >
> {}

export const GetCostCategories = Binding.Service<GetCostCategories>(
  "AWS.CostExplorer.GetCostCategories",
);
