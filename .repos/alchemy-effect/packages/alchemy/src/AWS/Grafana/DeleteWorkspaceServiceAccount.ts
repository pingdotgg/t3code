import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `DeleteWorkspaceServiceAccount` operation (IAM
 * action `grafana:DeleteWorkspaceServiceAccount`), scoped to one
 * {@link Workspace}.
 *
 * Deletes a Grafana service account from the workspace. Any API tokens
 * minted for the account stop working immediately. Provide the
 * implementation with
 * `Effect.provide(AWS.Grafana.DeleteWorkspaceServiceAccountHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example Delete a Service Account
 * ```typescript
 * const deleteServiceAccount =
 *   yield* Grafana.DeleteWorkspaceServiceAccount(workspace);
 *
 * yield* deleteServiceAccount({ serviceAccountId: account.id });
 * ```
 */
export interface DeleteWorkspaceServiceAccount extends Binding.Service<
  DeleteWorkspaceServiceAccount,
  "AWS.Grafana.DeleteWorkspaceServiceAccount",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<
        grafana.DeleteWorkspaceServiceAccountRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.DeleteWorkspaceServiceAccountResponse,
      grafana.DeleteWorkspaceServiceAccountError
    >
  >
> {}
export const DeleteWorkspaceServiceAccount =
  Binding.Service<DeleteWorkspaceServiceAccount>(
    "AWS.Grafana.DeleteWorkspaceServiceAccount",
  );
