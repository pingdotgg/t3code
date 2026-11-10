import * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Layer from "effect/Layer";
import { makeComprehendMedicalHttpBinding } from "./BindingHttp.ts";
import { ListPHIDetectionJobs } from "./ListPHIDetectionJobs.ts";

export const ListPHIDetectionJobsHttp = Layer.effect(
  ListPHIDetectionJobs,
  makeComprehendMedicalHttpBinding({
    capability: "ListPHIDetectionJobs",
    iamActions: ["comprehendmedical:ListPHIDetectionJobs"],
    operation: comprehendmedical.listPHIDetectionJobs,
  }),
);
