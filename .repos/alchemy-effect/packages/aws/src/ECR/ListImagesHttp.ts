import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { ListImages } from "./ListImages.ts";

/** HTTP implementation of {@link ListImages} over the ECR API. */
export const ListImagesHttp = Layer.effect(
  ListImages,
  makeEcrRepositoryHttpBinding({
    capability: "ListImages",
    operation: ecr.listImages,
    iamActions: ["ecr:ListImages"],
  }),
);
