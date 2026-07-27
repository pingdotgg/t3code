import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RepositoryLink } from "./RepositoryLink.ts";

/**
 * Request for {@link ListRepositorySyncDefinitions} — the sync type to
 * list; the repository link ID is injected from the bound resource.
 */
export interface ListRepositorySyncDefinitionsRequest extends Omit<
  codeconnections.ListRepositorySyncDefinitionsInput,
  "RepositoryLinkId"
> {}

/**
 * Runtime binding for `codeconnections:ListRepositorySyncDefinitions`.
 *
 * Bind this operation to a {@link RepositoryLink} to enumerate the sync
 * definitions Git sync tracks for the link — branch, directory, and target
 * per definition. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.ListRepositorySyncDefinitionsHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example List the Link's Sync Definitions
 * ```typescript
 * // init — bind the operation to the repository link
 * const listRepositorySyncDefinitions =
 *   yield* AWS.CodeConnections.ListRepositorySyncDefinitions(link);
 *
 * // runtime
 * const { RepositorySyncDefinitions } =
 *   yield* listRepositorySyncDefinitions({ SyncType: "CFN_STACK_SYNC" });
 * ```
 */
export interface ListRepositorySyncDefinitions extends Binding.Service<
  ListRepositorySyncDefinitions,
  "AWS.CodeConnections.ListRepositorySyncDefinitions",
  (
    repositoryLink: RepositoryLink,
  ) => Effect.Effect<
    (
      request: ListRepositorySyncDefinitionsRequest,
    ) => Effect.Effect<
      codeconnections.ListRepositorySyncDefinitionsOutput,
      codeconnections.ListRepositorySyncDefinitionsError
    >
  >
> {}

export const ListRepositorySyncDefinitions =
  Binding.Service<ListRepositorySyncDefinitions>(
    "AWS.CodeConnections.ListRepositorySyncDefinitions",
  );
