import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `DescribeAccessControlConfiguration` request with `IndexId` injected from the bound index.
 */
export interface DescribeAccessControlConfigurationRequest extends Omit<
  kendra.DescribeAccessControlConfigurationRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `DescribeAccessControlConfiguration` operation (IAM action
 * `kendra:DescribeAccessControlConfiguration`), scoped to one {@link Index}.
 *
 * Reads one access-control configuration of the index.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.DescribeAccessControlConfigurationHttp)`.
 *
 * @binding
 * @section Access Control Configurations
 * @example Describe a Runtime ACL
 * ```typescript
 * const describeAcl =
 *   yield* AWS.Kendra.DescribeAccessControlConfiguration(index);
 *
 * const acl = yield* describeAcl({ Id: configurationId });
 * console.log(acl.Name, acl.AccessControlList);
 * ```
 */
export interface DescribeAccessControlConfiguration extends Binding.Service<
  DescribeAccessControlConfiguration,
  "AWS.Kendra.DescribeAccessControlConfiguration",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: DescribeAccessControlConfigurationRequest,
    ) => Effect.Effect<
      kendra.DescribeAccessControlConfigurationResponse,
      kendra.DescribeAccessControlConfigurationError
    >
  >
> {}
export const DescribeAccessControlConfiguration =
  Binding.Service<DescribeAccessControlConfiguration>(
    "AWS.Kendra.DescribeAccessControlConfiguration",
  );
