import * as sagemaker from "@distilled.cloud/aws/sagemaker";
import * as Layer from "effect/Layer";
import { makeEndpointHttpBinding } from "./BindingHttp.ts";
import { UpdateEndpointWeightsAndCapacities } from "./UpdateEndpointWeightsAndCapacities.ts";

export const UpdateEndpointWeightsAndCapacitiesHttp = Layer.effect(
  UpdateEndpointWeightsAndCapacities,
  makeEndpointHttpBinding({
    tag: "AWS.SageMaker.UpdateEndpointWeightsAndCapacities",
    operation: sagemaker.updateEndpointWeightsAndCapacities,
    actions: ["sagemaker:UpdateEndpointWeightsAndCapacities"],
  }),
);
