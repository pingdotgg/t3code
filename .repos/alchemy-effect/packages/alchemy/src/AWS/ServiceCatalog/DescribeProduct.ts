import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:DescribeProduct`.
 *
 * Gets information about a product the caller has access to, including its provisioning artifacts (versions) and launch paths.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.DescribeProductHttp)`.
 * @binding
 * @section Browsing the Catalog
 * @example Get a Product's Artifacts and Launch Paths
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeProduct = yield* AWS.ServiceCatalog.DescribeProduct();
 *
 * // runtime
 * const { ProductViewSummary, ProvisioningArtifacts } =
 *   yield* describeProduct({ Id: "prod-abc123" });
 * ```
 */
export interface DescribeProduct extends Binding.Service<
  DescribeProduct,
  "AWS.ServiceCatalog.DescribeProduct",
  () => Effect.Effect<
    (
      request?: servicecatalog.DescribeProductInput,
    ) => Effect.Effect<
      servicecatalog.DescribeProductOutput,
      servicecatalog.DescribeProductError
    >
  >
> {}
export const DescribeProduct = Binding.Service<DescribeProduct>(
  "AWS.ServiceCatalog.DescribeProduct",
);
