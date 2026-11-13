import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { GetDownloadUrlForLayer } from "./GetDownloadUrlForLayer.ts";

/** HTTP implementation of {@link GetDownloadUrlForLayer} over the ECR API. */
export const GetDownloadUrlForLayerHttp = Layer.effect(
  GetDownloadUrlForLayer,
  makeEcrRepositoryHttpBinding({
    capability: "GetDownloadUrlForLayer",
    operation: ecr.getDownloadUrlForLayer,
    iamActions: ["ecr:GetDownloadUrlForLayer"],
  }),
);
