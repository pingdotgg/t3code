import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListPiiEntitiesDetectionJobs } from "./ListPiiEntitiesDetectionJobs.ts";

export const ListPiiEntitiesDetectionJobsHttp = Layer.effect(
  ListPiiEntitiesDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListPiiEntitiesDetectionJobs",
    operation: comprehend.listPiiEntitiesDetectionJobs,
    actions: ["comprehend:ListPiiEntitiesDetectionJobs"],
  }),
);
