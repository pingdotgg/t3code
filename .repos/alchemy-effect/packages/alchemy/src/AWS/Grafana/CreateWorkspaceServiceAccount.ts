import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `CreateWorkspaceServiceAccount` operation (IAM
 * action `grafana:CreateWorkspaceServiceAccount`), scoped to one
 * {@link Workspace}.
 *
 * Creates a Grafana service account in the workspace — a non-user identity
 * for machine access to the Grafana HTTP API (dashboards, alerts, data
 * sources). Mint API tokens for it with
 * `CreateWorkspaceServiceAccountToken`. Requires Grafana 9 or newer.
 * Provide the implementation with
 * `Effect.provide(AWS.Grafana.CreateWorkspaceServiceAccountHttp)`.
 * @binding
 * @section Managing Service Accounts
 * @example Create an Automation Service Account
 * ```typescript
 * const createServiceAccount =
 *   yield* Grafana.CreateWorkspaceServiceAccount(workspace);
 *
 * const account = yield* createServiceAccount({
 *   name: "dashboard-automation",
 *   grafanaRole: "EDITOR",
 * });
 * // account.id → the service account id used for token operations
 * ```
 */
export interface CreateWorkspaceServiceAccount extends Binding.Service<
  CreateWorkspaceServiceAccount,
  "AWS.Grafana.CreateWorkspaceServiceAccount",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<
        grafana.CreateWorkspaceServiceAccountRequest,
        "workspaceId"
      >,
    ) => Effect.Effect<
      grafana.CreateWorkspaceServiceAccountResponse,
      grafana.CreateWorkspaceServiceAccountError
    >
  >
> {}
export const CreateWorkspaceServiceAccount =
  Binding.Service<CreateWorkspaceServiceAccount>(
    "AWS.Grafana.CreateWorkspaceServiceAccount",
  );
