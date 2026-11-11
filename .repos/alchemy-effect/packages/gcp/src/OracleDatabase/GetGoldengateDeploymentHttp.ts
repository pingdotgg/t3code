import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetGoldengateDeployment } from "./GetGoldengateDeployment.ts";

/**
 * HTTP implementation of {@link GetGoldengateDeployment}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateDeployment
 */
export const GetGoldengateDeploymentHttp = Layer.effect(
  GetGoldengateDeployment,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateDeployment",
    operation: oracle.getProjectsLocationsGoldengateDeployments,
    iam: { role: "roles/oracledatabase.goldenGateDeploymentViewer" },
  }),
);
