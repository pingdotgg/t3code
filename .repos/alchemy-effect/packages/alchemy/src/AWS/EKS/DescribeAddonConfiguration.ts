import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `eks:DescribeAddonConfiguration`.
 *
 * Reads an add-on version's configuration JSON schema — the shape its `configurationValues` must satisfy.
 * `eks:DescribeAddonConfiguration` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeAddonConfigurationHttp)`.
 * @binding
 * @section Version Catalogs
 * @example Read an Add-on's Configuration Schema
 * ```typescript
 * // init
 * const describeAddonConfiguration =
 *   yield* AWS.EKS.DescribeAddonConfiguration();
 *
 * // runtime
 * const { configurationSchema } = yield* describeAddonConfiguration({
 *   addonName: "vpc-cni",
 *   addonVersion,
 * });
 * ```
 */
export interface DescribeAddonConfiguration extends Binding.Service<
  DescribeAddonConfiguration,
  "AWS.EKS.DescribeAddonConfiguration",
  () => Effect.Effect<
    (
      request: eks.DescribeAddonConfigurationRequest,
    ) => Effect.Effect<
      eks.DescribeAddonConfigurationResponse,
      eks.DescribeAddonConfigurationError
    >
  >
> {}
export const DescribeAddonConfiguration =
  Binding.Service<DescribeAddonConfiguration>(
    "AWS.EKS.DescribeAddonConfiguration",
  );
