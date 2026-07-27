import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `ListAccessControlConfigurations` request with `IndexId` injected from the bound index.
 */
export interface ListAccessControlConfigurationsRequest extends Omit<
  kendra.ListAccessControlConfigurationsRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `ListAccessControlConfigurations` operation (IAM action
 * `kendra:ListAccessControlConfigurations`), scoped to one {@link Index}.
 *
 * Lists the index's access-control configurations.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.ListAccessControlConfigurationsHttp)`.
 *
 * @binding
 * @section Access Control Configurations
 * @example List Runtime ACLs
 * ```typescript
 * const listAcls =
 *   yield* AWS.Kendra.ListAccessControlConfigurations(index);
 *
 * const { AccessControlConfigurations } = yield* listAcls();
 * ```
 */
export interface ListAccessControlConfigurations extends Binding.Service<
  ListAccessControlConfigurations,
  "AWS.Kendra.ListAccessControlConfigurations",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request?: ListAccessControlConfigurationsRequest,
    ) => Effect.Effect<
      kendra.ListAccessControlConfigurationsResponse,
      kendra.ListAccessControlConfigurationsError
    >
  >
> {}
export const ListAccessControlConfigurations =
  Binding.Service<ListAccessControlConfigurations>(
    "AWS.Kendra.ListAccessControlConfigurations",
  );
