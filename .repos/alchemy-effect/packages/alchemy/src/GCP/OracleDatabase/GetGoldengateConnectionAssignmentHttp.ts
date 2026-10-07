import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetGoldengateConnectionAssignment } from "./GetGoldengateConnectionAssignment.ts";

/**
 * HTTP implementation of {@link GetGoldengateConnectionAssignment}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateConnectionAssignment
 */
export const GetGoldengateConnectionAssignmentHttp = Layer.effect(
  GetGoldengateConnectionAssignment,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateConnectionAssignment",
    operation: oracle.getProjectsLocationsGoldengateConnectionAssignments,
    iam: { role: "roles/oracledatabase.goldenGateConnectionAssignmentViewer" },
  }),
);
