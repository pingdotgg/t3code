import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `eks:DescribeAddonVersions`.
 *
 * Reads the add-on catalog — which add-ons (and versions) are available, per Kubernetes version.
 * `eks:DescribeAddonVersions` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeAddonVersionsHttp)`.
 * @binding
 * @section Version Catalogs
 * @example Find Compatible vpc-cni Versions
 * ```typescript
 * // init
 * const describeAddonVersions = yield* AWS.EKS.DescribeAddonVersions();
 *
 * // runtime
 * const { addons } = yield* describeAddonVersions({
 *   addonName: "vpc-cni",
 *   kubernetesVersion: "1.31",
 * });
 * ```
 */
export interface DescribeAddonVersions extends Binding.Service<
  DescribeAddonVersions,
  "AWS.EKS.DescribeAddonVersions",
  () => Effect.Effect<
    (
      request?: eks.DescribeAddonVersionsRequest,
    ) => Effect.Effect<
      eks.DescribeAddonVersionsResponse,
      eks.DescribeAddonVersionsError
    >
  >
> {}
export const DescribeAddonVersions = Binding.Service<DescribeAddonVersions>(
  "AWS.EKS.DescribeAddonVersions",
);
