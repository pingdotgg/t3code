import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { BatchCheckLayerAvailability } from "./BatchCheckLayerAvailability.ts";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";

/** HTTP implementation of {@link BatchCheckLayerAvailability} over the ECR API. */
export const BatchCheckLayerAvailabilityHttp = Layer.effect(
  BatchCheckLayerAvailability,
  makeEcrRepositoryHttpBinding({
    capability: "BatchCheckLayerAvailability",
    operation: ecr.batchCheckLayerAvailability,
    iamActions: ["ecr:BatchCheckLayerAvailability"],
  }),
);
