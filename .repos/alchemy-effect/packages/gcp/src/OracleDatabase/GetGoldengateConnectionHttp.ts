import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GetGoldengateConnection } from "./GetGoldengateConnection.ts";

/**
 * HTTP implementation of {@link GetGoldengateConnection}.
 *
 * @layer
 * @provides GCP.OracleDatabase.GetGoldengateConnection
 */
export const GetGoldengateConnectionHttp = Layer.effect(
  GetGoldengateConnection,
  makeOracleNameHttpBinding({
    tag: "GCP.OracleDatabase.GetGoldengateConnection",
    operation: oracle.getProjectsLocationsGoldengateConnections,
    iam: { role: "roles/oracledatabase.goldenGateConnectionViewer" },
  }),
);
