import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `UpdateWorkspaceConfiguration` operation (IAM
 * action `grafana:UpdateWorkspaceConfiguration`), scoped to one
 * {@link Workspace}.
 *
 * Writes the workspace's Grafana configuration JSON string and can also
 * trigger an in-place Grafana version upgrade via `grafanaVersion`. Provide
 * the implementation with
 * `Effect.provide(AWS.Grafana.UpdateWorkspaceConfigurationHttp)`.
 * @binding
 * @section Managing Configuration
 * @example Enable Unified Alerting
 * ```typescript
 * const updateConfig = yield* Grafana.UpdateWorkspaceConfiguration(workspace);
 *
 * yield* updateConfig({
 *   configuration: JSON.stringify({
 *     unifiedAlerting: { enabled: true },
 *   }),
 * });
 * ```
 */
export interface UpdateWorkspaceConfiguration extends Binding.Service<
  UpdateWorkspaceConfiguration,
  "AWS.Grafana.UpdateWorkspaceConfiguration",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<grafana.UpdateWorkspaceConfigurationRequest, "workspaceId">,
    ) => Effect.Effect<
      grafana.UpdateWorkspaceConfigurationResponse,
      grafana.UpdateWorkspaceConfigurationError
    >
  >
> {}
export const UpdateWorkspaceConfiguration =
  Binding.Service<UpdateWorkspaceConfiguration>(
    "AWS.Grafana.UpdateWorkspaceConfiguration",
  );
