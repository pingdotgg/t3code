import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `UpdateAccessControlConfiguration` request with `IndexId` injected from the bound index.
 */
export interface UpdateAccessControlConfigurationRequest extends Omit<
  kendra.UpdateAccessControlConfigurationRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `UpdateAccessControlConfiguration` operation (IAM action
 * `kendra:UpdateAccessControlConfiguration`), scoped to one {@link Index}.
 *
 * Updates an access-control configuration's name, description, or
 * user/group ACLs.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.UpdateAccessControlConfigurationHttp)`.
 *
 * @binding
 * @section Access Control Configurations
 * @example Update a Runtime ACL
 * ```typescript
 * const updateAcl =
 *   yield* AWS.Kendra.UpdateAccessControlConfiguration(index);
 *
 * yield* updateAcl({
 *   Id: configurationId,
 *   AccessControlList: [{ Name: "sam", Type: "USER", Access: "ALLOW" }],
 * });
 * ```
 */
export interface UpdateAccessControlConfiguration extends Binding.Service<
  UpdateAccessControlConfiguration,
  "AWS.Kendra.UpdateAccessControlConfiguration",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: UpdateAccessControlConfigurationRequest,
    ) => Effect.Effect<
      kendra.UpdateAccessControlConfigurationResponse,
      kendra.UpdateAccessControlConfigurationError
    >
  >
> {}
export const UpdateAccessControlConfiguration =
  Binding.Service<UpdateAccessControlConfiguration>(
    "AWS.Kendra.UpdateAccessControlConfiguration",
  );
