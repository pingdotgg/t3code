import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { ListTopicsDetectionJobs } from "./ListTopicsDetectionJobs.ts";

export const ListTopicsDetectionJobsHttp = Layer.effect(
  ListTopicsDetectionJobs,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.ListTopicsDetectionJobs",
    operation: comprehend.listTopicsDetectionJobs,
    actions: ["comprehend:ListTopicsDetectionJobs"],
  }),
);
