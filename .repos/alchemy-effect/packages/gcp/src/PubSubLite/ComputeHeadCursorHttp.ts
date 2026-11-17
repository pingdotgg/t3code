import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeTopicStatsHttpBinding } from "./BindingHttp.ts";
import { ComputeHeadCursor } from "./ComputeHeadCursor.ts";

/**
 * HTTP implementation of {@link ComputeHeadCursor}.
 *
 * @layer
 * @provides GCP.PubSubLite.ComputeHeadCursor
 */
export const ComputeHeadCursorHttp = Layer.effect(
  ComputeHeadCursor,
  makeTopicStatsHttpBinding({
    tag: "GCP.PubSubLite.ComputeHeadCursor",
    iam: { role: "roles/pubsublite.subscriber" },
    operation: pubsublite.computeHeadCursorTopicStatsProjectsLocationsTopics,
  }),
);
