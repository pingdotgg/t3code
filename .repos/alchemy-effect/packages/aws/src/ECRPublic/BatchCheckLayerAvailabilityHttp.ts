import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { BatchCheckLayerAvailability } from "./BatchCheckLayerAvailability.ts";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";

export const BatchCheckLayerAvailabilityHttp = Layer.effect(
  BatchCheckLayerAvailability,
  makePublicRepositoryHttpBinding({
    capability: "BatchCheckLayerAvailability",
    iamActions: ["ecr-public:BatchCheckLayerAvailability"],
    operation: ecrpublic.batchCheckLayerAvailability,
  }),
);
