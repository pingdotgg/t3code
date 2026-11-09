import type * as backup from "@distilled.cloud/aws/backup";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for the `ListProtectedResources` operation (IAM action
 * `backup:ListProtectedResources`).
 *
 * Lists the resources successfully backed up by AWS Backup — each entry
 * carries the resource ARN, type, and last-backup time. Provide the
 * implementation with `Effect.provide(AWS.Backup.ListProtectedResourcesHttp)`.
 * ### Protected Resources
 * **Example:** List Protected Resources
 * ```typescript
 * const listProtectedResources = yield* AWS.Backup.ListProtectedResources();
 *
 * const page = yield* listProtectedResources({ MaxResults: 25 });
 * ```
 *
 * @binding
 */
export interface ListProtectedResources extends Binding.Service<
  ListProtectedResources,
  "AWS.Backup.ListProtectedResources",
  () => Effect.Effect<
    (
      request?: backup.ListProtectedResourcesInput,
    ) => Effect.Effect<backup.ListProtectedResourcesOutput, backup.ListProtectedResourcesError>
  >
> {}
export const ListProtectedResources = Binding.Service<ListProtectedResources>(
  "AWS.Backup.ListProtectedResources",
);
