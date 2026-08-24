import type * as redshift from "@distilled.cloud/aws/redshift";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeClusters` operation (IAM action
 * `redshift:DescribeClusters`).
 *
 * Lists the account's provisioned Redshift clusters or looks one up by
 * identifier — e.g. an ops function that checks whether the warehouse is
 * `available` before submitting a load. Provide the implementation with
 * `Effect.provide(AWS.Redshift.DescribeClustersHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Check a Cluster's Status
 * ```typescript
 * const describeClusters = yield* AWS.Redshift.DescribeClusters();
 *
 * const page = yield* describeClusters({ ClusterIdentifier: clusterId });
 * const status = page.Clusters?.[0]?.ClusterStatus;
 * ```
 */
export interface DescribeClusters extends Binding.Service<
  DescribeClusters,
  "AWS.Redshift.DescribeClusters",
  () => Effect.Effect<
    (
      request?: redshift.DescribeClustersMessage,
    ) => Effect.Effect<redshift.ClustersMessage, redshift.DescribeClustersError>
  >
> {}
export const DescribeClusters = Binding.Service<DescribeClusters>(
  "AWS.Redshift.DescribeClusters",
);
