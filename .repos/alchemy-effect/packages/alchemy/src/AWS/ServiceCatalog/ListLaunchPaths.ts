import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:ListLaunchPaths`.
 *
 * Lists the launch paths (the portfolio routes through which the caller can provision a product). The path ID is required by `ProvisionProduct` when the product is published to more than one portfolio.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.ListLaunchPathsHttp)`.
 * @binding
 * @section Browsing the Catalog
 * @example Find the Launch Path for a Product
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listLaunchPaths = yield* AWS.ServiceCatalog.ListLaunchPaths();
 *
 * // runtime
 * const { LaunchPathSummaries } = yield* listLaunchPaths({
 *   ProductId: "prod-abc123",
 * });
 * ```
 */
export interface ListLaunchPaths extends Binding.Service<
  ListLaunchPaths,
  "AWS.ServiceCatalog.ListLaunchPaths",
  () => Effect.Effect<
    (
      request: servicecatalog.ListLaunchPathsInput,
    ) => Effect.Effect<
      servicecatalog.ListLaunchPathsOutput,
      servicecatalog.ListLaunchPathsError
    >
  >
> {}
export const ListLaunchPaths = Binding.Service<ListLaunchPaths>(
  "AWS.ServiceCatalog.ListLaunchPaths",
);
