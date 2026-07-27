import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListRecoveryPointsByResource` operation (IAM
 * action `backup:ListRecoveryPointsByResource`).
 *
 * Lists the recovery points for a specific protected resource by its ARN —
 * find the newest recovery point to restore from. Provide the implementation
 * with `Effect.provide(AWS.Backup.ListRecoveryPointsByResourceHttp)`.
 * @binding
 * @section Recovery Points
 * @example Find A Resource's Recovery Points
 * ```typescript
 * const listRecoveryPointsByResource =
 *   yield* AWS.Backup.ListRecoveryPointsByResource();
 *
 * const page = yield* listRecoveryPointsByResource({
 *   ResourceArn: tableArn,
 *   MaxResults: 10,
 * });
 * ```
 */
export interface ListRecoveryPointsByResource extends Binding.Service<
  ListRecoveryPointsByResource,
  "AWS.Backup.ListRecoveryPointsByResource",
  () => Effect.Effect<
    (
      request: backup.ListRecoveryPointsByResourceInput,
    ) => Effect.Effect<
      backup.ListRecoveryPointsByResourceOutput,
      backup.ListRecoveryPointsByResourceError
    >
  >
> {}
export const ListRecoveryPointsByResource =
  Binding.Service<ListRecoveryPointsByResource>(
    "AWS.Backup.ListRecoveryPointsByResource",
  );
