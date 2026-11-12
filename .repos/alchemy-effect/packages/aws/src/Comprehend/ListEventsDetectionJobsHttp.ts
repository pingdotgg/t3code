import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListEventsDetectionJobs } from "./ListEventsDetectionJobs.ts";

export const ListEventsDetectionJobsHttp = Layer.effect(
  ListEventsDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListEventsDetectionJobs",
    operation: comprehend.listEventsDetectionJobs,
    actions: ["comprehend:ListEventsDetectionJobs"],
  }),
);
