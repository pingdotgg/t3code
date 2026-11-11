import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListEntitiesDetectionJobs } from "./ListEntitiesDetectionJobs.ts";

export const ListEntitiesDetectionJobsHttp = Layer.effect(
  ListEntitiesDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListEntitiesDetectionJobs",
    operation: comprehend.listEntitiesDetectionJobs,
    actions: ["comprehend:ListEntitiesDetectionJobs"],
  }),
);
