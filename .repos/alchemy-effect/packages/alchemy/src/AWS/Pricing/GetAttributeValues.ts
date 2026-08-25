import type * as pricing from "@distilled.cloud/aws/pricing";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetAttributeValuesRequest
  extends pricing.GetAttributeValuesRequest {}

/**
 * Runtime binding for `pricing:GetAttributeValues` — list the values of a
 * filterable attribute (e.g. every `volumeType` AWS prices for
 * `AmazonEC2`).
 *
 * Use `DescribeServices` to discover attribute names, then this binding to
 * enumerate their values, and feed both into `GetProducts` filters. The
 * binding takes no arguments and grants the function
 * `pricing:GetAttributeValues` (the action has no resource-level IAM).
 * Calls are pinned to `us-east-1`, the region that serves the Price List
 * API. Provide the implementation with
 * `Effect.provide(AWS.Pricing.GetAttributeValuesHttp)`.
 *
 * @binding
 * @section Listing Attribute Values
 * @example List EC2 Volume Types
 * ```typescript
 * // init
 * const getAttributeValues = yield* AWS.Pricing.GetAttributeValues();
 *
 * // runtime
 * const result = yield* getAttributeValues({
 *   ServiceCode: "AmazonEC2",
 *   AttributeName: "volumeType",
 * });
 * const volumeTypes = (result.AttributeValues ?? []).map((v) => v.Value);
 * ```
 */
export interface GetAttributeValues extends Binding.Service<
  GetAttributeValues,
  "AWS.Pricing.GetAttributeValues",
  () => Effect.Effect<
    (
      request: GetAttributeValuesRequest,
    ) => Effect.Effect<
      pricing.GetAttributeValuesResponse,
      pricing.GetAttributeValuesError
    >
  >
> {}
export const GetAttributeValues = Binding.Service<GetAttributeValues>(
  "AWS.Pricing.GetAttributeValues",
);
