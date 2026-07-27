import type * as eks from "@distilled.cloud/aws/eks";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `eks:ListUpdates`.
 *
 * Enumerates the update IDs issued against the bound cluster (or one of its node groups / add-ons).
 * The cluster `name` is injected from the bound {@link Cluster} and `eks:ListUpdates` is granted on the cluster's ARN and sub-resource ARNs.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.ListUpdatesHttp)`.
 * @binding
 * @section Tracking Updates
 * @example List Cluster Updates
 * ```typescript
 * // init
 * const listUpdates = yield* AWS.EKS.ListUpdates(cluster);
 *
 * // runtime
 * const { updateIds } = yield* listUpdates();
 * ```
 */
export interface ListUpdates extends Binding.Service<
  ListUpdates,
  "AWS.EKS.ListUpdates",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: Omit<eks.ListUpdatesRequest, "name">,
    ) => Effect.Effect<eks.ListUpdatesResponse, eks.ListUpdatesError>
  >
> {}
export const ListUpdates = Binding.Service<ListUpdates>("AWS.EKS.ListUpdates");
