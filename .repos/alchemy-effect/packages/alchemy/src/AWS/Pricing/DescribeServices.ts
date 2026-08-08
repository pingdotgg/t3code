import type * as pricing from "@distilled.cloud/aws/pricing";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeServicesRequest
  extends pricing.DescribeServicesRequest {}

/**
 * Runtime binding for `pricing:DescribeServices` — list the service codes
 * known to the AWS Price List API, or the filterable attribute names of one
 * service.
 *
 * Call it without a `ServiceCode` to enumerate every service code, or with
 * one (e.g. `AmazonEC2`) to get the attribute names you can filter
 * `GetProducts` by (`instanceType`, `location`, `operatingSystem`, ...).
 * The binding takes no arguments and grants the function
 * `pricing:DescribeServices` (the action has no resource-level IAM). Calls
 * are pinned to `us-east-1`, the region that serves the Price List API.
 * Provide the implementation with
 * `Effect.provide(AWS.Pricing.DescribeServicesHttp)`.
 *
 * @binding
 * @section Discovering Services
 * @example List Filterable Attributes for EC2
 * ```typescript
 * // init
 * const describeServices = yield* AWS.Pricing.DescribeServices();
 *
 * // runtime
 * const result = yield* describeServices({ ServiceCode: "AmazonEC2" });
 * const attributeNames = result.Services?.[0]?.AttributeNames ?? [];
 * ```
 */
export interface DescribeServices extends Binding.Service<
  DescribeServices,
  "AWS.Pricing.DescribeServices",
  () => Effect.Effect<
    (
      request?: DescribeServicesRequest,
    ) => Effect.Effect<
      pricing.DescribeServicesResponse,
      pricing.DescribeServicesError
    >
  >
> {}
export const DescribeServices = Binding.Service<DescribeServices>(
  "AWS.Pricing.DescribeServices",
);
