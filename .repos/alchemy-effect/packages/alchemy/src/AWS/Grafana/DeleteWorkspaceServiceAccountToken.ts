import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `DeleteWorkspaceServiceAccountToken` operation
 * (IAM action `grafana:DeleteWorkspaceServiceAccountToken`), scoped to one
 * {@link Workspace}.
 *
 * Revokes a service account API token — the other half of a token-rotation
 * loop. Provide the implementation with
 * `Effect.provide(AWS.Grafana.DeleteWorkspaceServiceAccountTokenHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example Revoke a Rotated-Out Token
 * ```typescript
 * const deleteToken =
 *   yield* Grafana.DeleteWorkspaceServiceAccountToken(workspace);
 *
 * yield* deleteToken({
 *   serviceAccountId: account.id,
 *   tokenId: staleToken.id,
 * });
 * ```
 */
export interface DeleteWorkspaceServiceAccountToken extends Binding.Service<
  DeleteWorkspaceServiceAccountToken,
  "AWS.Grafana.DeleteWorkspaceServiceAccountToken",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<
        grafana.DeleteWorkspaceServiceAccountTokenRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.DeleteWorkspaceServiceAccountTokenResponse,
      grafana.DeleteWorkspaceServiceAccountTokenError
    >
  >
> {}
export const DeleteWorkspaceServiceAccountToken =
  Binding.Service<DeleteWorkspaceServiceAccountToken>(
    "AWS.Grafana.DeleteWorkspaceServiceAccountToken",
  );
