import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeServiceHttpBinding } from "./BindingHttp.ts";
import { ExecuteGraphqlRead } from "./ExecuteGraphqlRead.ts";

/**
 * HTTP implementation of {@link ExecuteGraphqlRead}.
 *
 * @layer
 * @provides GCP.FirebaseDataConnect.ExecuteGraphqlRead
 */
export const ExecuteGraphqlReadHttp = Layer.effect(
  ExecuteGraphqlRead,
  makeServiceHttpBinding({
    tag: "GCP.FirebaseDataConnect.ExecuteGraphqlRead",
    iam: { role: "roles/firebasedataconnect.dataViewer" },
    operation: firebasedataconnect.executeGraphqlReadProjectsLocationsServices,
  }),
);
