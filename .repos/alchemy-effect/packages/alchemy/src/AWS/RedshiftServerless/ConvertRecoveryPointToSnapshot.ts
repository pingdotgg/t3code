import type * as serverless from "@distilled.cloud/aws/redshift-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ConvertRecoveryPointToSnapshot` operation (IAM actions
 * `redshift-serverless:ConvertRecoveryPointToSnapshot` +
 * `redshift-serverless:TagResource`).
 *
 * Converts an automatic recovery point into a manual snapshot so it
 * outlives the 24-hour recovery-point window. Provide the implementation with
 * `Effect.provide(AWS.RedshiftServerless.ConvertRecoveryPointToSnapshotHttp)`.
 * @binding
 * @section Working with Recovery Points
 * @example Preserve a Recovery Point as a Snapshot
 * ```typescript
 * // init — resolve the runtime client
 * const convert = yield* AWS.RedshiftServerless.ConvertRecoveryPointToSnapshot();
 *
 * yield* convert({ recoveryPointId, snapshotName: `preserved-${runId}` });
 * ```
 */
export interface ConvertRecoveryPointToSnapshot extends Binding.Service<
  ConvertRecoveryPointToSnapshot,
  "AWS.RedshiftServerless.ConvertRecoveryPointToSnapshot",
  () => Effect.Effect<
    (
      request: serverless.ConvertRecoveryPointToSnapshotRequest,
    ) => Effect.Effect<
      serverless.ConvertRecoveryPointToSnapshotResponse,
      serverless.ConvertRecoveryPointToSnapshotError
    >
  >
> {}
export const ConvertRecoveryPointToSnapshot =
  Binding.Service<ConvertRecoveryPointToSnapshot>(
    "AWS.RedshiftServerless.ConvertRecoveryPointToSnapshot",
  );
