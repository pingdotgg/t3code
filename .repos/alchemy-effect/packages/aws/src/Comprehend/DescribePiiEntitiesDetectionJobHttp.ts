import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Layer from "effect/Layer";
import { makeComprehendHttpBinding } from "./BindingHttp.ts";
import { DescribePiiEntitiesDetectionJob } from "./DescribePiiEntitiesDetectionJob.ts";

export const DescribePiiEntitiesDetectionJobHttp = Layer.effect(
  DescribePiiEntitiesDetectionJob,
  makeComprehendHttpBinding({
    tag: "AWS.Comprehend.DescribePiiEntitiesDetectionJob",
    operation: comprehend.describePiiEntitiesDetectionJob,
    actions: ["comprehend:DescribePiiEntitiesDetectionJob"],
  }),
);
