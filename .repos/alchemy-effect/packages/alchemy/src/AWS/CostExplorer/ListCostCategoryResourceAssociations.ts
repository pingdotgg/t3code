import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CostCategory } from "./CostCategory.ts";

/**
 * Request for {@link ListCostCategoryResourceAssociations} — the bound cost category's ARN is
 * injected automatically.
 */
export interface ListCostCategoryResourceAssociationsRequest extends Omit<
  ce.ListCostCategoryResourceAssociationsRequest,
  "CostCategoryArn"
> {}

/**
 * Runtime binding for `ce:ListCostCategoryResourceAssociations`.
 *
 * List the resources associated with the bound cost category's
 * values. The category's ARN is injected into the request; the IAM grant
 * is on `*` (the action supports no resource types). Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListCostCategoryResourceAssociationsHttp)`.
 * @binding
 * @section Cost Category Associations
 * @example List a Category's Resource Associations
 * ```typescript
 * // init — bind the operation to the cost category
 * const listCostCategoryResourceAssociations = yield* AWS.CostExplorer.ListCostCategoryResourceAssociations(category);
 *
 * // runtime
 * const result = yield* listCostCategoryResourceAssociations();
 * const associations = result.CostCategoryResourceAssociations;
 * ```
 */
export interface ListCostCategoryResourceAssociations extends Binding.Service<
  ListCostCategoryResourceAssociations,
  "AWS.CostExplorer.ListCostCategoryResourceAssociations",
  (
    category: CostCategory,
  ) => Effect.Effect<
    (
      request?: ListCostCategoryResourceAssociationsRequest,
    ) => Effect.Effect<
      ce.ListCostCategoryResourceAssociationsResponse,
      ce.ListCostCategoryResourceAssociationsError
    >
  >
> {}

export const ListCostCategoryResourceAssociations =
  Binding.Service<ListCostCategoryResourceAssociations>(
    "AWS.CostExplorer.ListCostCategoryResourceAssociations",
  );
