import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `wafv2:DescribeManagedRuleGroup` — read the rules,
 * labels, and WCU capacity of a vendor managed rule group.
 *
 * Provide `WAFv2.DescribeManagedRuleGroupHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managed Rule Group Catalog
 * @example Describe the AWS Common Rule Set
 * ```typescript
 * // init — grants wafv2:DescribeManagedRuleGroup
 * const describeManagedRuleGroup = yield* AWS.WAFv2.DescribeManagedRuleGroup();
 *
 * // runtime
 * const { Capacity, Rules } = yield* describeManagedRuleGroup({
 *   VendorName: "AWS",
 *   Name: "AWSManagedRulesCommonRuleSet",
 *   Scope: "REGIONAL",
 * });
 * ```
 */
export interface DescribeManagedRuleGroup extends Binding.Service<
  DescribeManagedRuleGroup,
  "AWS.WAFv2.DescribeManagedRuleGroup",
  () => Effect.Effect<
    (
      request: WAFV2.DescribeManagedRuleGroupRequest,
    ) => Effect.Effect<
      WAFV2.DescribeManagedRuleGroupResponse,
      WAFV2.DescribeManagedRuleGroupError
    >
  >
> {}

export const DescribeManagedRuleGroup =
  Binding.Service<DescribeManagedRuleGroup>(
    "AWS.WAFv2.DescribeManagedRuleGroup",
  );

/**
 * Runtime binding for `wafv2:ListAvailableManagedRuleGroups` — list the
 * vendor managed rule groups available to the account (AWS Managed Rules +
 * subscribed Marketplace groups).
 *
 * Provide `WAFv2.ListAvailableManagedRuleGroupsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managed Rule Group Catalog
 * @example List Available Managed Rule Groups
 * ```typescript
 * // init — grants wafv2:ListAvailableManagedRuleGroups
 * const listManagedRuleGroups = yield* AWS.WAFv2.ListAvailableManagedRuleGroups();
 *
 * // runtime
 * const { ManagedRuleGroups } = yield* listManagedRuleGroups({
 *   Scope: "REGIONAL",
 * });
 * ```
 */
export interface ListAvailableManagedRuleGroups extends Binding.Service<
  ListAvailableManagedRuleGroups,
  "AWS.WAFv2.ListAvailableManagedRuleGroups",
  () => Effect.Effect<
    (
      request: WAFV2.ListAvailableManagedRuleGroupsRequest,
    ) => Effect.Effect<
      WAFV2.ListAvailableManagedRuleGroupsResponse,
      WAFV2.ListAvailableManagedRuleGroupsError
    >
  >
> {}

export const ListAvailableManagedRuleGroups =
  Binding.Service<ListAvailableManagedRuleGroups>(
    "AWS.WAFv2.ListAvailableManagedRuleGroups",
  );

/**
 * Runtime binding for `wafv2:ListAvailableManagedRuleGroupVersions` — list
 * the published versions of a vendor managed rule group.
 *
 * Provide `WAFv2.ListAvailableManagedRuleGroupVersionsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Managed Rule Group Catalog
 * @example List Versions of the Common Rule Set
 * ```typescript
 * // init — grants wafv2:ListAvailableManagedRuleGroupVersions
 * const listVersions = yield* AWS.WAFv2.ListAvailableManagedRuleGroupVersions();
 *
 * // runtime
 * const { Versions, CurrentDefaultVersion } = yield* listVersions({
 *   VendorName: "AWS",
 *   Name: "AWSManagedRulesCommonRuleSet",
 *   Scope: "REGIONAL",
 * });
 * ```
 */
export interface ListAvailableManagedRuleGroupVersions extends Binding.Service<
  ListAvailableManagedRuleGroupVersions,
  "AWS.WAFv2.ListAvailableManagedRuleGroupVersions",
  () => Effect.Effect<
    (
      request: WAFV2.ListAvailableManagedRuleGroupVersionsRequest,
    ) => Effect.Effect<
      WAFV2.ListAvailableManagedRuleGroupVersionsResponse,
      WAFV2.ListAvailableManagedRuleGroupVersionsError
    >
  >
> {}

export const ListAvailableManagedRuleGroupVersions =
  Binding.Service<ListAvailableManagedRuleGroupVersions>(
    "AWS.WAFv2.ListAvailableManagedRuleGroupVersions",
  );

/**
 * Runtime binding for `wafv2:DescribeAllManagedProducts` — read the
 * catalog of managed rule group products from AWS and Marketplace vendors.
 *
 * Provide `WAFv2.DescribeAllManagedProductsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Managed Rule Group Catalog
 * @example List All Managed Products
 * ```typescript
 * // init — grants wafv2:DescribeAllManagedProducts
 * const describeAllManagedProducts = yield* AWS.WAFv2.DescribeAllManagedProducts();
 *
 * // runtime
 * const { ManagedProducts } = yield* describeAllManagedProducts({
 *   Scope: "REGIONAL",
 * });
 * ```
 */
export interface DescribeAllManagedProducts extends Binding.Service<
  DescribeAllManagedProducts,
  "AWS.WAFv2.DescribeAllManagedProducts",
  () => Effect.Effect<
    (
      request: WAFV2.DescribeAllManagedProductsRequest,
    ) => Effect.Effect<
      WAFV2.DescribeAllManagedProductsResponse,
      WAFV2.DescribeAllManagedProductsError
    >
  >
> {}

export const DescribeAllManagedProducts =
  Binding.Service<DescribeAllManagedProducts>(
    "AWS.WAFv2.DescribeAllManagedProducts",
  );

/**
 * Runtime binding for `wafv2:DescribeManagedProductsByVendor` — read the
 * managed rule group products of a single vendor.
 *
 * Provide `WAFv2.DescribeManagedProductsByVendorHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Managed Rule Group Catalog
 * @example List AWS-Vended Managed Products
 * ```typescript
 * // init — grants wafv2:DescribeManagedProductsByVendor
 * const describeByVendor = yield* AWS.WAFv2.DescribeManagedProductsByVendor();
 *
 * // runtime
 * const { ManagedProducts } = yield* describeByVendor({
 *   VendorName: "AWS",
 *   Scope: "REGIONAL",
 * });
 * ```
 */
export interface DescribeManagedProductsByVendor extends Binding.Service<
  DescribeManagedProductsByVendor,
  "AWS.WAFv2.DescribeManagedProductsByVendor",
  () => Effect.Effect<
    (
      request: WAFV2.DescribeManagedProductsByVendorRequest,
    ) => Effect.Effect<
      WAFV2.DescribeManagedProductsByVendorResponse,
      WAFV2.DescribeManagedProductsByVendorError
    >
  >
> {}

export const DescribeManagedProductsByVendor =
  Binding.Service<DescribeManagedProductsByVendor>(
    "AWS.WAFv2.DescribeManagedProductsByVendor",
  );
