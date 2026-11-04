import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeReservationHttpBinding } from "./BindingHttp.ts";
import { GetReservation } from "./GetReservation.ts";

/**
 * HTTP implementation of {@link GetReservation}.
 *
 * @layer
 * @provides GCP.PubSubLite.GetReservation
 */
export const GetReservationHttp = Layer.effect(
  GetReservation,
  makeReservationHttpBinding({
    tag: "GCP.PubSubLite.GetReservation",
    iam: { role: "roles/pubsublite.viewer" },
    operation: pubsublite.getAdminProjectsLocationsReservations,
  }),
);
