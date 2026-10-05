import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Layer from "effect/Layer";
import { makeGenerateAccessTokenHttpBinding } from "./BindingHttp.ts";
import { GenerateAccessToken } from "./GenerateAccessToken.ts";

/**
 * HTTP implementation of {@link GenerateAccessToken}.
 *
 * @layer
 * @provides GCP.Workstations.GenerateAccessToken
 */
export const GenerateAccessTokenHttp = Layer.effect(
  GenerateAccessToken,
  makeGenerateAccessTokenHttpBinding({
    tag: "GCP.Workstations.GenerateAccessToken",
    iam: { role: "roles/workstations.user", on: "workstations.workstation" },
    operation:
      workstations.generateAccessTokenProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations,
  }),
);
