import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RepositoryLink } from "./RepositoryLink.ts";

/**
 * Request for {@link GetRepositorySyncStatus} — the branch and sync type to
 * read; the repository link ID is injected from the bound resource.
 */
export interface GetRepositorySyncStatusRequest extends Omit<
  codeconnections.GetRepositorySyncStatusInput,
  "RepositoryLinkId"
> {}

/**
 * Runtime binding for `codeconnections:GetRepositorySyncStatus`.
 *
 * Bind this operation to a {@link RepositoryLink} to read the latest Git
 * sync attempt for a branch — its status and the sync events that led to
 * it — from inside a function runtime. Useful for dashboards that surface
 * whether a stack is in sync with its repository. Provide the
 * implementation with
 * `Effect.provide(AWS.CodeConnections.GetRepositorySyncStatusHttp)`.
 * @binding
 * @section Monitoring Git Sync
 * @example Read a Branch's Latest Sync Attempt
 * ```typescript
 * // init — bind the operation to the repository link
 * const getRepositorySyncStatus =
 *   yield* AWS.CodeConnections.GetRepositorySyncStatus(link);
 *
 * // runtime
 * const { LatestSync } = yield* getRepositorySyncStatus({
 *   Branch: "main",
 *   SyncType: "CFN_STACK_SYNC",
 * });
 * ```
 */
export interface GetRepositorySyncStatus extends Binding.Service<
  GetRepositorySyncStatus,
  "AWS.CodeConnections.GetRepositorySyncStatus",
  (
    repositoryLink: RepositoryLink,
  ) => Effect.Effect<
    (
      request: GetRepositorySyncStatusRequest,
    ) => Effect.Effect<
      codeconnections.GetRepositorySyncStatusOutput,
      codeconnections.GetRepositorySyncStatusError
    >
  >
> {}

export const GetRepositorySyncStatus = Binding.Service<GetRepositorySyncStatus>(
  "AWS.CodeConnections.GetRepositorySyncStatus",
);
