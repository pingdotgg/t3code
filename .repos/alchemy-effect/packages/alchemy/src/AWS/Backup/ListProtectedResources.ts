import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListProtectedResources` operation (IAM action
 * `backup:ListProtectedResources`).
 *
 * Lists the resources successfully backed up by AWS Backup — each entry
 * carries the resource ARN, type, and last-backup time. Provide the
 * implementation with `Effect.provide(AWS.Backup.ListProtectedResourcesHttp)`.
 * @binding
 * @section Protected Resources
 * @example List Protected Resources
 * ```typescript
 * const listProtectedResources = yield* AWS.Backup.ListProtectedResources();
 *
 * const page = yield* listProtectedResources({ MaxResults: 25 });
 * ```
 */
export interface ListProtectedResources extends Binding.Service<
  ListProtectedResources,
  "AWS.Backup.ListProtectedResources",
  () => Effect.Effect<
    (
      request?: backup.ListProtectedResourcesInput,
    ) => Effect.Effect<
      backup.ListProtectedResourcesOutput,
      backup.ListProtectedResourcesError
    >
  >
> {}
export const ListProtectedResources = Binding.Service<ListProtectedResources>(
  "AWS.Backup.ListProtectedResources",
);
