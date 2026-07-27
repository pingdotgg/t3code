import type * as amp from "@distilled.cloud/aws/amp";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListWorkspacesRequest extends amp.ListWorkspacesRequest {}

/**
 * Runtime binding for `aps:ListWorkspaces`.
 *
 * An account-level binding — call it with no arguments to get a callable that
 * lists AMP workspaces in the region. Provide the `ListWorkspacesHttp` layer
 * on the Function to satisfy the binding.
 *
 * @binding
 * @section Workspace Metadata
 * @example List Workspaces in the Region
 * ```typescript
 * const listWorkspaces = yield* AMP.ListWorkspaces();
 *
 * const response = yield* listWorkspaces();
 * const ids = response.workspaces.map((workspace) => workspace.workspaceId);
 * ```
 */
export interface ListWorkspaces extends Binding.Service<
  ListWorkspaces,
  "AWS.AMP.ListWorkspaces",
  () => Effect.Effect<
    (
      request?: ListWorkspacesRequest,
    ) => Effect.Effect<amp.ListWorkspacesResponse, amp.ListWorkspacesError>
  >
> {}
export const ListWorkspaces = Binding.Service<ListWorkspaces>(
  "AWS.AMP.ListWorkspaces",
);
