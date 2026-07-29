import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListAccessEntries`.
 *
 * Enumerates the IAM principal ARNs granted Kubernetes access to the bound cluster via access entries.
 * The cluster `clusterName` is injected from the bound {@link Cluster} and `eks:ListAccessEntries` is granted on the cluster's ARN.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListAccessEntriesHttp)`.
 * @binding
 * @section Inspecting Identity and Access
 * @example List Access Entries
 * ```typescript
 * // init
 * const listAccessEntries = yield* AWS.EKS.ListAccessEntries(cluster);
 *
 * // runtime
 * const { accessEntries } = yield* listAccessEntries();
 * ```
 */
export interface ListAccessEntries extends Binding.Service<
  ListAccessEntries,
  "AWS.EKS.ListAccessEntries",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListAccessEntriesRequest, "clusterName">,
    ) => Effect.Effect<
      eks.ListAccessEntriesResponse,
      eks.ListAccessEntriesError
    >
  >
> {}
export const ListAccessEntries = Binding.Service<ListAccessEntries>(
  "AWS.EKS.ListAccessEntries",
);
