import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `DeleteAccessControlConfiguration` request with `IndexId` injected from the bound index.
 */
export interface DeleteAccessControlConfigurationRequest extends Omit<
  kendra.DeleteAccessControlConfigurationRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `DeleteAccessControlConfiguration` operation (IAM action
 * `kendra:DeleteAccessControlConfiguration`), scoped to one {@link Index}.
 *
 * Deletes an access-control configuration from the index.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.DeleteAccessControlConfigurationHttp)`.
 *
 * @binding
 * @section Access Control Configurations
 * @example Delete a Runtime ACL
 * ```typescript
 * const deleteAcl =
 *   yield* AWS.Kendra.DeleteAccessControlConfiguration(index);
 *
 * yield* deleteAcl({ Id: configurationId });
 * ```
 */
export interface DeleteAccessControlConfiguration extends Binding.Service<
  DeleteAccessControlConfiguration,
  "AWS.Kendra.DeleteAccessControlConfiguration",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: DeleteAccessControlConfigurationRequest,
    ) => Effect.Effect<
      kendra.DeleteAccessControlConfigurationResponse,
      kendra.DeleteAccessControlConfigurationError
    >
  >
> {}
export const DeleteAccessControlConfiguration =
  Binding.Service<DeleteAccessControlConfiguration>(
    "AWS.Kendra.DeleteAccessControlConfiguration",
  );
