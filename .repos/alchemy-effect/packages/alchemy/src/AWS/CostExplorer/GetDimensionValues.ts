import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetDimensionValues}.
 */
export interface GetDimensionValuesRequest
  extends ce.GetDimensionValuesRequest {}

/**
 * Runtime binding for `ce:GetDimensionValues`.
 *
 * Retrieve the available values for a Cost Explorer dimension
 * (services, linked accounts, regions, usage types, …) — the building
 * blocks of query filter expressions. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.GetDimensionValuesHttp)`.
 * @binding
 * @section Exploring Dimensions and Tags
 * @example List Available Services
 * ```typescript
 * // init — account-level binding takes no resource
 * const getDimensionValues = yield* AWS.CostExplorer.GetDimensionValues();
 *
 * // runtime
 * const result = yield* getDimensionValues({
 *   TimePeriod: { Start: "2026-06-01", End: "2026-07-01" },
 *   Dimension: "SERVICE",
 * });
 * const services = (result.DimensionValues ?? []).map((v) => v.Value);
 * ```
 */
export interface GetDimensionValues extends Binding.Service<
  GetDimensionValues,
  "AWS.CostExplorer.GetDimensionValues",
  () => Effect.Effect<
    (
      request: GetDimensionValuesRequest,
    ) => Effect.Effect<
      ce.GetDimensionValuesResponse,
      ce.GetDimensionValuesError
    >
  >
> {}

export const GetDimensionValues = Binding.Service<GetDimensionValues>(
  "AWS.CostExplorer.GetDimensionValues",
);
