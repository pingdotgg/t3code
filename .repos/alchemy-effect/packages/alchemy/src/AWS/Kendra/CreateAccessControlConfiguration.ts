import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `CreateAccessControlConfiguration` request with `IndexId` injected from the bound index.
 */
export interface CreateAccessControlConfigurationRequest extends Omit<
  kendra.CreateAccessControlConfigurationRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `CreateAccessControlConfiguration` operation (IAM action
 * `kendra:CreateAccessControlConfiguration`), scoped to one {@link Index}.
 *
 * Creates a named access-control configuration (user/group ACLs) on the
 * index. Kendra designed this for runtime use: re-apply access changes
 * to documents at query time without re-indexing them — e.g. revoke a
 * departed user's access, then reference the returned `Id` from a
 * document's `AccessControlConfigurationId`.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.CreateAccessControlConfigurationHttp)`.
 *
 * @binding
 * @section Access Control Configurations
 * @example Create a Runtime ACL
 * ```typescript
 * const createAcl =
 *   yield* AWS.Kendra.CreateAccessControlConfiguration(index);
 *
 * const { Id } = yield* createAcl({
 *   Name: "block-departed-users",
 *   AccessControlList: [
 *     { Name: "departed-user", Type: "USER", Access: "DENY" },
 *   ],
 * });
 * ```
 */
export interface CreateAccessControlConfiguration extends Binding.Service<
  CreateAccessControlConfiguration,
  "AWS.Kendra.CreateAccessControlConfiguration",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: CreateAccessControlConfigurationRequest,
    ) => Effect.Effect<
      kendra.CreateAccessControlConfigurationResponse,
      kendra.CreateAccessControlConfigurationError
    >
  >
> {}
export const CreateAccessControlConfiguration =
  Binding.Service<CreateAccessControlConfiguration>(
    "AWS.Kendra.CreateAccessControlConfiguration",
  );
