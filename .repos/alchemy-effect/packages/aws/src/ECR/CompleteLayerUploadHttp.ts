import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { CompleteLayerUpload } from "./CompleteLayerUpload.ts";

/** HTTP implementation of {@link CompleteLayerUpload} over the ECR API. */
export const CompleteLayerUploadHttp = Layer.effect(
  CompleteLayerUpload,
  makeEcrRepositoryHttpBinding({
    capability: "CompleteLayerUpload",
    operation: ecr.completeLayerUpload,
    iamActions: ["ecr:CompleteLayerUpload"],
  }),
);
