import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";
import { CompleteLayerUpload } from "./CompleteLayerUpload.ts";

export const CompleteLayerUploadHttp = Layer.effect(
  CompleteLayerUpload,
  makePublicRepositoryHttpBinding({
    capability: "CompleteLayerUpload",
    iamActions: ["ecr-public:CompleteLayerUpload"],
    operation: ecrpublic.completeLayerUpload,
  }),
);
