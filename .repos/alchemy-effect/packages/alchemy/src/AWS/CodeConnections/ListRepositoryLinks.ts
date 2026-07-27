import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListRepositoryLinks}.
 */
export interface ListRepositoryLinksRequest
  extends codeconnections.ListRepositoryLinksInput {}

/**
 * Runtime binding for `codeconnections:ListRepositoryLinks`.
 *
 * An account-level operation (no repository-link argument) that enumerates
 * the account's repository links — the Git-sync attachments between a
 * connection and a specific provider repository. Useful for sync dashboards
 * that discover which repositories are wired up before drilling into their
 * sync status. Provide the implementation with
 * `Effect.provide(AWS.CodeConnections.ListRepositoryLinksHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example List the Account's Repository Links
 * ```typescript
 * // init — account-level binding takes no resource
 * const listRepositoryLinks =
 *   yield* AWS.CodeConnections.ListRepositoryLinks();
 *
 * // runtime
 * const result = yield* listRepositoryLinks();
 * const repos = (result.RepositoryLinks ?? []).map((l) => l.RepositoryName);
 * ```
 */
export interface ListRepositoryLinks extends Binding.Service<
  ListRepositoryLinks,
  "AWS.CodeConnections.ListRepositoryLinks",
  () => Effect.Effect<
    (
      request?: ListRepositoryLinksRequest,
    ) => Effect.Effect<
      codeconnections.ListRepositoryLinksOutput,
      codeconnections.ListRepositoryLinksError
    >
  >
> {}

export const ListRepositoryLinks = Binding.Service<ListRepositoryLinks>(
  "AWS.CodeConnections.ListRepositoryLinks",
);
