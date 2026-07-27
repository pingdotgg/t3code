import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `PutRestoreValidationResult` operation (IAM action
 * `backup:PutRestoreValidationResult`).
 *
 * Reports the result of a restore-test validation. This is the canonical
 * runtime use of AWS Backup: restore testing invokes a validation Lambda
 * after a restore-test job completes; the Lambda checks the restored
 * resource (fetch its metadata with `GetRestoreJobMetadata`, query the
 * restored table/volume, …) and posts `SUCCESSFUL` or `FAILED` back to the
 * restore job. Provide the implementation with
 * `Effect.provide(AWS.Backup.PutRestoreValidationResultHttp)`.
 * @binding
 * @section Restore Testing Validation
 * @example Report A Restore Test Verdict
 * ```typescript
 * const putRestoreValidationResult =
 *   yield* AWS.Backup.PutRestoreValidationResult();
 *
 * yield* putRestoreValidationResult({
 *   RestoreJobId: restoreJobId,
 *   ValidationStatus: "SUCCESSFUL",
 *   ValidationStatusMessage: "restored table row count matches source",
 * });
 * ```
 */
export interface PutRestoreValidationResult extends Binding.Service<
  PutRestoreValidationResult,
  "AWS.Backup.PutRestoreValidationResult",
  () => Effect.Effect<
    (
      request: backup.PutRestoreValidationResultInput,
    ) => Effect.Effect<
      backup.PutRestoreValidationResultResponse,
      backup.PutRestoreValidationResultError
    >
  >
> {}
export const PutRestoreValidationResult =
  Binding.Service<PutRestoreValidationResult>(
    "AWS.Backup.PutRestoreValidationResult",
  );
