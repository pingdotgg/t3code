import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Layer from "effect/Layer";
import { makeDistributionScopedHttpBinding } from "./BindingHttp.ts";
import { GetInvalidation } from "./GetInvalidation.ts";

export const GetInvalidationHttp = Layer.effect(
  GetInvalidation,
  makeDistributionScopedHttpBinding({
    tag: "AWS.CloudFront.GetInvalidation",
    operation: cloudfront.getInvalidation,
    actions: ["cloudfront:GetInvalidation"],
  }),
);
