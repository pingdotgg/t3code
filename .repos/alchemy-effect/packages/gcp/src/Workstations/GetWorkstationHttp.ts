import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import { GetWorkstation } from "./GetWorkstation.ts";

/**
 * HTTP implementation of {@link GetWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.GetWorkstation
 */
export const GetWorkstationHttp = Layer.effect(
  GetWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.GetWorkstation",
    iam: { role: "roles/workstations.viewer", on: "workstations.workstation" },
    operation: workstations.getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
