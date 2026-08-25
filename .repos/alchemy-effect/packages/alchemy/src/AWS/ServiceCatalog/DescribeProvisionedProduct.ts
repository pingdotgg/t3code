import type * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `servicecatalog:DescribeProvisionedProduct`.
 *
 * Gets information about a provisioned product by ID or name — its status (`AVAILABLE`, `UNDER_CHANGE`, `ERROR`, …) and the record of its last operation.
 *
 * Account-level operation — which products the caller can see and act on
 * is governed by portfolio principal associations, so the binding takes no
 * resource argument. Provide the implementation with
 * `Effect.provide(AWS.ServiceCatalog.DescribeProvisionedProductHttp)`.
 * @binding
 * @section Tracking Provisioned Products
 * @example Get a Provisioned Product's Status
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeProvisionedProduct = yield* AWS.ServiceCatalog.DescribeProvisionedProduct();
 *
 * // runtime
 * const { ProvisionedProductDetail } =
 *   yield* describeProvisionedProduct({ Name: "my-vpc" });
 * ```
 */
export interface DescribeProvisionedProduct extends Binding.Service<
  DescribeProvisionedProduct,
  "AWS.ServiceCatalog.DescribeProvisionedProduct",
  () => Effect.Effect<
    (
      request?: servicecatalog.DescribeProvisionedProductInput,
    ) => Effect.Effect<
      servicecatalog.DescribeProvisionedProductOutput,
      servicecatalog.DescribeProvisionedProductError
    >
  >
> {}
export const DescribeProvisionedProduct =
  Binding.Service<DescribeProvisionedProduct>(
    "AWS.ServiceCatalog.DescribeProvisionedProduct",
  );
