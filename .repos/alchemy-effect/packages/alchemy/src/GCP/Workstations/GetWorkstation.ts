import type * as workstations from "@distilled.cloud/gcp/workstations_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";

export interface GetWorkstationRequest extends Omit<
  workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Workstations `workstations.get`.
 *
 * Bind this operation to a
 * {@link WorkstationClustersWorkstationConfigsWorkstation} in a
 * Function/Action init phase. Provide {@link GetWorkstationHttp}.
 * Grants `roles/workstations.viewer` on the workstation only.
 *
 * ### Observing Workstations
 * **Example:** Read the bound workstation
 * ```typescript
 * const getWorkstation = yield* GCP.Workstations.GetWorkstation(dev);
 * const live = yield* getWorkstation();
 * ```
 *
 * @binding
 * @category Workstations
 */
export interface GetWorkstation extends Binding.Service<
  GetWorkstation,
  "GCP.Workstations.GetWorkstation",
  (
    workstation: WorkstationClustersWorkstationConfigsWorkstation,
  ) => Effect.Effect<
    (
      request?: GetWorkstationRequest,
    ) => Effect.Effect<
      workstations.Workstation,
      workstations.GetProjectsLocationsWorkstationClustersWorkstationConfigsWorkstationsError,
      RuntimeContext
    >
  >
> {}

export const GetWorkstation = Binding.Service<GetWorkstation>(
  "GCP.Workstations.GetWorkstation",
);
