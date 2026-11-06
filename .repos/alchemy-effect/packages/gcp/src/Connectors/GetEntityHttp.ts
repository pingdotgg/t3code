import * as connectors from "@distilled.cloud/gcp/connectors_v2";
import * as Layer from "effect/Layer";
import { makeEntityHttpBinding } from "./BindingHttp.ts";
import { GetEntity } from "./GetEntity.ts";

/**
 * HTTP implementation of {@link GetEntity}.
 *
 * @layer
 * @provides GCP.Connectors.GetEntity
 */
export const GetEntityHttp = Layer.effect(
  GetEntity,
  makeEntityHttpBinding({
    tag: "GCP.Connectors.GetEntity",
    iam: { role: "roles/connectors.invoker" },
    operation: connectors.getProjectsLocationsConnectionsEntityTypesEntities,
  }),
);
