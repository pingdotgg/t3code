import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeConnectorHttpBinding } from "./BindingHttp.ts";
import { ExecuteQuery } from "./ExecuteQuery.ts";

/**
 * HTTP implementation of {@link ExecuteQuery}.
 *
 * @layer
 * @provides GCP.FirebaseDataConnect.ExecuteQuery
 */
export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  makeConnectorHttpBinding({
    tag: "GCP.FirebaseDataConnect.ExecuteQuery",
    iam: { role: "roles/firebasedataconnect.dataViewer" },
    operation: firebasedataconnect.executeQueryProjectsLocationsServicesConnectors,
  }),
);
