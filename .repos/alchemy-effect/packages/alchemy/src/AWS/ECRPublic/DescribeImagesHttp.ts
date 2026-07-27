import * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import * as Layer from "effect/Layer";
import { makePublicRepositoryHttpBinding } from "./BindingHttp.ts";
import { DescribeImages } from "./DescribeImages.ts";

export const DescribeImagesHttp = Layer.effect(
  DescribeImages,
  makePublicRepositoryHttpBinding({
    capability: "DescribeImages",
    iamActions: ["ecr-public:DescribeImages"],
    operation: ecrpublic.describeImages,
  }),
);
