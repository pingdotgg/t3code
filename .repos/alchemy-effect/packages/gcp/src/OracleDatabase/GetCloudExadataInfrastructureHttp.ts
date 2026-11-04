import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetCloudExadataInfrastructure } from "./GetCloudExadataInfrastructure.ts";

/**
 * HTTP implementation of {@link GetCloudExadataInfrastructure}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetCloudExadataInfrastructure
 */
export const GetCloudExadataInfrastructureHttp = Layer.effect(
  GetCloudExadataInfrastructure,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetCloudExadataInfrastructure",
    operation: oracle.getProjectsLocationsCloudExadataInfrastructures,
    iam: { role: "roles/oracledatabase.cloudExadataInfrastructureViewer" },
  }),
);
