import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RepositoryLink } from "./RepositoryLink.ts";

/**
 * Request for {@link ListSyncConfigurations} — the sync type to list; the
 * repository link ID is injected from the bound resource.
 */
export interface ListSyncConfigurationsRequest extends Omit<
  codeconnections.ListSyncConfigurationsInput,
  "RepositoryLinkId"
> {}

/**
 * Runtime binding for `codeconnections:ListSyncConfigurations`.
 *
 * Bind this operation to a {@link RepositoryLink} to enumerate the sync
 * configurations attached to the link — which AWS resources Git sync keeps
 * converged from the linked repository. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.ListSyncConfigurationsHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example List the Link's Sync Configurations
 * ```typescript
 * // init — bind the operation to the repository link
 * const listSyncConfigurations =
 *   yield* AWS.CodeConnections.ListSyncConfigurations(link);
 *
 * // runtime
 * const { SyncConfigurations } =
 *   yield* listSyncConfigurations({ SyncType: "CFN_STACK_SYNC" });
 * ```
 */
export interface ListSyncConfigurations extends Binding.Service<
  ListSyncConfigurations,
  "AWS.CodeConnections.ListSyncConfigurations",
  (
    repositoryLink: RepositoryLink,
  ) => Effect.Effect<
    (
      request: ListSyncConfigurationsRequest,
    ) => Effect.Effect<
      codeconnections.ListSyncConfigurationsOutput,
      codeconnections.ListSyncConfigurationsError
    >
  >
> {}

export const ListSyncConfigurations = Binding.Service<ListSyncConfigurations>(
  "AWS.CodeConnections.ListSyncConfigurations",
);
