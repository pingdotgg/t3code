import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { DescribeImages } from "./DescribeImages.ts";

/** HTTP implementation of {@link DescribeImages} over the ECR API. */
export const DescribeImagesHttp = Layer.effect(
  DescribeImages,
  makeEcrRepositoryHttpBinding({
    capability: "DescribeImages",
    operation: ecr.describeImages,
    iamActions: ["ecr:DescribeImages"],
  }),
);
