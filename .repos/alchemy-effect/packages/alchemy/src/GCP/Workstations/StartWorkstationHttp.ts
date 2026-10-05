import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeWorkstationHttpBinding } from "./BindingHttp.ts";
import { StartWorkstation } from "./StartWorkstation.ts";

/**
 * HTTP implementation of {@link StartWorkstation}.
 *
 * @layer
 * @provides GCP.Workstations.StartWorkstation
 */
export const StartWorkstationHttp = Layer.effect(
  StartWorkstation,
  makeWorkstationHttpBinding({
    tag: "GCP.Workstations.StartWorkstation",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation:
      workstations.startProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
