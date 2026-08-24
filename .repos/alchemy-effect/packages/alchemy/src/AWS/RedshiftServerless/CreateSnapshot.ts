import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";

/**
 * Runtime binding for the `CreateSnapshot` operation (IAM actions
 * `redshift-serverless:CreateSnapshot` +
 * `redshift-serverless:TagResource`).
 *
 * Takes a manual snapshot of the bound {@link Namespace} — e.g. a
 * pre-migration backup function or a scheduled snapshot-rotation job. The
 * namespace name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.CreateSnapshotHttp)`.
 * @binding
 * @section Managing Snapshots
 * @example Take a Manual Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const createSnapshot = yield* AWS.RedshiftServerless.CreateSnapshot(namespace);
 *
 * // runtime
 * yield* createSnapshot({
 *   snapshotName: `pre-migration-${runId}`,
 *   retentionPeriod: 7,
 * });
 * ```
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "AWS.RedshiftServerless.CreateSnapshot",
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (
      request: Omit<serverless.CreateSnapshotRequest, "namespaceName">,
    ) => Effect.Effect<
      serverless.CreateSnapshotResponse,
      serverless.CreateSnapshotError
    >
  >
> {}
export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "AWS.RedshiftServerless.CreateSnapshot",
);
