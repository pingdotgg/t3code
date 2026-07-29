import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `RestoreFromSnapshot` operation (IAM actions
 * `redshift-serverless:RestoreFromSnapshot`).
 *
 * Restores the bound {@link Namespace} from a snapshot — a
 * disaster-recovery runbook step. The namespace name is injected from the
 * binding; pass the serving workgroup and the snapshot to restore. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.RestoreFromSnapshotHttp)`.
 * @binding
 * @section Restoring Data
 * @example Restore a Namespace from a Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const restoreFromSnapshot = yield* AWS.RedshiftServerless.RestoreFromSnapshot(namespace);
 *
 * yield* restoreFromSnapshot({
 *   workgroupName,
 *   snapshotName: "pre-migration-1",
 * });
 * ```
 */
export interface RestoreFromSnapshot extends Binding.Service<
  RestoreFromSnapshot,
  "AWS.RedshiftServerless.RestoreFromSnapshot",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<serverless.RestoreFromSnapshotRequest, "namespaceName">,
    ) => Effect.Effect<
      serverless.RestoreFromSnapshotResponse,
      serverless.RestoreFromSnapshotError
    >
  >
> {}
export const RestoreFromSnapshot = Binding.Service<RestoreFromSnapshot>(
  "AWS.RedshiftServerless.RestoreFromSnapshot",
);
