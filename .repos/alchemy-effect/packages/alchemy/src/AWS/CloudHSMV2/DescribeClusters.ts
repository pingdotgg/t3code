import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeClusters` operation (IAM action
 * `cloudhsm:DescribeClusters`).
 *
 * Lists the account's CloudHSM clusters (optionally filtered by cluster id,
 * VPC or state) with each cluster's HSMs embedded — the building block of
 * cluster-health monitoring and automatic-HSM-replacement automation.
 * Provide the implementation with
 * `Effect.provide(AWS.CloudHSMV2.DescribeClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check A Cluster's HSM Health
 * ```typescript
 * const describeClusters = yield* AWS.CloudHSMV2.DescribeClusters();
 *
 * const page = yield* describeClusters({
 *   Filters: { clusterIds: [clusterId] },
 * });
 * const active = page.Clusters?.[0]?.Hsms?.filter(
 *   (hsm) => hsm.State === "ACTIVE",
 * );
 * ```
 */
export interface DescribeClusters extends Binding.Service<
  DescribeClusters,
  "AWS.CloudHSMV2.DescribeClusters",
  () => Effect.Effect<
    (
      request?: cloudhsm.DescribeClustersRequest,
    ) => Effect.Effect<
      cloudhsm.DescribeClustersResponse,
      cloudhsm.DescribeClustersError
    >
  >
> {}
export const DescribeClusters = Binding.Service<DescribeClusters>(
  "AWS.CloudHSMV2.DescribeClusters",
);
