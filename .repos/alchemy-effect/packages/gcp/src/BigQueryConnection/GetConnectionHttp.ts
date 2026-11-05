import * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import * as Layer from "effect/Layer";
import { makeConnectionHttpBinding } from "./BindingHttp.ts";
import { GetConnection } from "./GetConnection.ts";

/**
 * HTTP implementation of {@link GetConnection}.
 *
 * @layer
 * @provides GCP.BigQueryConnection.GetConnection
 */
export const GetConnectionHttp = Layer.effect(
  GetConnection,
  makeConnectionHttpBinding({
    tag: "GCP.BigQueryConnection.GetConnection",
    iam: {
      role: "roles/bigquery.connectionUser",
      on: "bigqueryconnection.connection",
    },
    operation: bigqueryconnection.getProjectsLocationsConnections,
  }),
);
