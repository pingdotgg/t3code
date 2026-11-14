import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeConnectorHttpBinding } from "./BindingHttp.ts";
import { ExecuteMutation } from "./ExecuteMutation.ts";

/**
 * HTTP implementation of {@link ExecuteMutation}.
 *
 * @layer
 * @provides GCP.FirebaseDataConnect.ExecuteMutation
 */
export const ExecuteMutationHttp = Layer.effect(
  ExecuteMutation,
  makeConnectorHttpBinding({
    tag: "GCP.FirebaseDataConnect.ExecuteMutation",
    iam: { role: "roles/firebasedataconnect.dataAdmin" },
    operation: firebasedataconnect.executeMutationProjectsLocationsServicesConnectors,
  }),
);
