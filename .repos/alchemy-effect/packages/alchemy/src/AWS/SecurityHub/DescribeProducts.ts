import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DescribeProducts`.
 *
 * Lists the product integrations available in Security Hub (AWS services and partner products).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DescribeProductsHttp)`.
 * @binding
 * @section Product Integrations
 * @example List Available Products
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeProducts = yield* AWS.SecurityHub.DescribeProducts();
 *
 * // runtime
 * const { Products } = yield* describeProducts({ MaxResults: 10 });
 * ```
 */
export interface DescribeProducts extends Binding.Service<
  DescribeProducts,
  "AWS.SecurityHub.DescribeProducts",
  () => Effect.Effect<
    (
      request?: securityhub.DescribeProductsRequest,
    ) => Effect.Effect<
      securityhub.DescribeProductsResponse,
      securityhub.DescribeProductsError
    >
  >
> {}
export const DescribeProducts = Binding.Service<DescribeProducts>(
  "AWS.SecurityHub.DescribeProducts",
);
