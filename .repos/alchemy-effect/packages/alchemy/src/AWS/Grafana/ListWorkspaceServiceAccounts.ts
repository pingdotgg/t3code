import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `ListWorkspaceServiceAccounts` operation (IAM
 * action `grafana:ListWorkspaceServiceAccounts`), scoped to one
 * {@link Workspace}.
 *
 * Lists the Grafana service accounts in the workspace. Provide the
 * implementation with
 * `Effect.provide(AWS.Grafana.ListWorkspaceServiceAccountsHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example List the Workspace's Service Accounts
 * ```typescript
 * const listServiceAccounts =
 *   yield* Grafana.ListWorkspaceServiceAccounts(workspace);
 *
 * const { serviceAccounts } = yield* listServiceAccounts();
 * for (const account of serviceAccounts) {
 *   yield* Effect.logInfo(`${account.name} (${account.grafanaRole})`);
 * }
 * ```
 */
export interface ListWorkspaceServiceAccounts extends Binding.Service<
  ListWorkspaceServiceAccounts,
  "AWS.Grafana.ListWorkspaceServiceAccounts",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request?: Omit<
        grafana.ListWorkspaceServiceAccountsRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.ListWorkspaceServiceAccountsResponse,
      grafana.ListWorkspaceServiceAccountsError
    >
  >
> {}
export const ListWorkspaceServiceAccounts =
  Binding.Service<ListWorkspaceServiceAccounts>(
    "AWS.Grafana.ListWorkspaceServiceAccounts",
  );
