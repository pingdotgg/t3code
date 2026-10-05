import type * as workstations from "@distilled.cloud/gcp/workstations_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkstationClustersWorkstationConfig } from "./WorkstationClustersWorkstationConfig.ts";

export interface GetWorkstationConfigRequest extends Omit<
  workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstationConfigs.get`.
 *
 * Bind this operation to a {@link WorkstationClustersWorkstationConfig} in
 * a Function/Action init phase. Provide {@link GetWorkstationConfigHttp}.
 * Grants `roles/workstations.viewer` on the configuration only.
 *
 * ### Observing Configurations
 * **Example:** Read the bound configuration
 * ```typescript
 * const getConfig = yield* GCP.Workstations.GetWorkstationConfig(config);
 * const live = yield* getConfig();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface GetWorkstationConfig extends Binding.Service<
  GetWorkstationConfig,
  "GCP.Workstations.GetWorkstationConfig",
  (
    config: WorkstationClustersWorkstationConfig,
  ) => Effect.Effect<
    (
      request?: GetWorkstationConfigRequest,
    ) => Effect.Effect<
      workstations.WorkstationConfig,
      workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsError,
      RuntimeContext
    >
  >
> {}

export const GetWorkstationConfig = Binding.Service<GetWorkstationConfig>(
  "GCP.Workstations.GetWorkstationConfig",
);
