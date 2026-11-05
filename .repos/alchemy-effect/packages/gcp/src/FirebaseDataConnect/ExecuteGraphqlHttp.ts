import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Layer from "effect/Layer";
import { makeServiceHttpBinding } from "./BindingHttp.ts";
import { ExecuteGraphql } from "./ExecuteGraphql.ts";

/**
 * HTTP implementation of {@link ExecuteGraphql}.
 *
 * @layer
 * @provides GCP.FirebaseDataConnect.ExecuteGraphql
 */
export const ExecuteGraphqlHttp = Layer.effect(
  ExecuteGraphql,
  makeServiceHttpBinding({
    tag: "GCP.FirebaseDataConnect.ExecuteGraphql",
    iam: { role: "roles/firebasedataconnect.dataAdmin" },
    operation: firebasedataconnect.executeGraphqlProjectsLocationsServices,
  }),
);
