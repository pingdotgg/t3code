import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `DescribeWorkspaceConfiguration` operation (IAM
 * action `grafana:DescribeWorkspaceConfiguration`), scoped to one
 * {@link Workspace}.
 *
 * Reads the workspace's Grafana configuration JSON string (e.g. the
 * `unifiedAlerting` feature toggle) and the running Grafana version. Provide
 * the implementation with
 * `Effect.provide(AWS.Grafana.DescribeWorkspaceConfigurationHttp)`.
 * @binding
 * @section Managing Configuration
 * @example Read the Configuration JSON
 * ```typescript
 * const describeConfig = yield* Grafana.DescribeWorkspaceConfiguration(workspace);
 *
 * const { configuration, grafanaVersion } = yield* describeConfig();
 * const parsed = JSON.parse(configuration);
 * ```
 */
export interface DescribeWorkspaceConfiguration extends Binding.Service<
  DescribeWorkspaceConfiguration,
  "AWS.Grafana.DescribeWorkspaceConfiguration",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    () => Effect.Effect<
      grafana.DescribeWorkspaceConfigurationResponse,
      grafana.DescribeWorkspaceConfigurationError
    >
  >
> {}
export const DescribeWorkspaceConfiguration =
  Binding.Service<DescribeWorkspaceConfiguration>(
    "AWS.Grafana.DescribeWorkspaceConfiguration",
  );
