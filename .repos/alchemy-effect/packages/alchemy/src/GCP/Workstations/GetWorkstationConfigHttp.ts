import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeConfigHttpBinding } from "./BindingHttp.ts";
import { GetWorkstationConfig } from "./GetWorkstationConfig.ts";

/**
 * HTTP implementation of {@link GetWorkstationConfig}.
 *
 * @layer
 * @provides GCP.Workstations.GetWorkstationConfig
 */
export const GetWorkstationConfigHttp = Layer.effect(
  GetWorkstationConfig,
  makeConfigHttpBinding({
    tag: "GCP.Workstations.GetWorkstationConfig",
    iam: {
      role: "roles/workstations.viewer",
      on: "workstations.workstationConfig",
    },
    operation:
      workstations.getProjectsLocationsWorkstationClustersWorkstationConfigs,
  }),
);
