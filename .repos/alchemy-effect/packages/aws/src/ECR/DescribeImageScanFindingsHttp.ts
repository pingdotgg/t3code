import * as ecr from "@distilled.cloud/aws/ecr";
import * as Layer from "effect/Layer";
import { makeEcrRepositoryHttpBinding } from "./BindingHttp.ts";
import { DescribeImageScanFindings } from "./DescribeImageScanFindings.ts";

/** HTTP implementation of {@link DescribeImageScanFindings} over the ECR API. */
export const DescribeImageScanFindingsHttp = Layer.effect(
  DescribeImageScanFindings,
  makeEcrRepositoryHttpBinding({
    capability: "DescribeImageScanFindings",
    operation: ecr.describeImageScanFindings,
    iamActions: ["ecr:DescribeImageScanFindings"],
  }),
);
