import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import { StopWorkstation } from "./StopWorkstation.ts";

/**
 * HTTP implementation of {@link StopWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.StopWorkstation
 */
export const StopWorkstationHttp = Layer.effect(
  StopWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.StopWorkstation",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation:
      workstations.stopProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
