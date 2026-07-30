import type * as ds from "@distilled.cloud/aws/directory-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetDirectoryLimits` operation (IAM action
 * `ds:GetDirectoryLimits`).
 *
 * Reads the account's directory limits for the current region — how many
 * cloud directories exist versus the allowed maximum — so an ops function
 * can alert before directory creation starts failing. The action does not
 * support resource-level permissions, so the grant is account-wide. Provide
 * the implementation with
 * `Effect.provide(AWS.DirectoryService.GetDirectoryLimitsHttp)`.
 * @binding
 * @section Reading Account Limits
 * @example Alert When the Directory Limit Is Near
 * ```typescript
 * // init — request the account-level capability
 * const getDirectoryLimits = yield* AWS.DirectoryService.GetDirectoryLimits();
 *
 * // runtime
 * const { DirectoryLimits } = yield* getDirectoryLimits();
 * if (DirectoryLimits?.CloudOnlyDirectoriesLimitReached) {
 *   yield* Effect.logWarning("directory limit reached");
 * }
 * ```
 */
export interface GetDirectoryLimits extends Binding.Service<
  GetDirectoryLimits,
  "AWS.DirectoryService.GetDirectoryLimits",
  () => Effect.Effect<
    () => Effect.Effect<ds.GetDirectoryLimitsResult, ds.GetDirectoryLimitsError>
  >
> {}
export const GetDirectoryLimits = Binding.Service<GetDirectoryLimits>(
  "AWS.DirectoryService.GetDirectoryLimits",
);
