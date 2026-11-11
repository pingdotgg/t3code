import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Layer from "effect/Layer";
import { makeDistributionScopedHttpBinding } from "./BindingHttp.ts";
import { CreateInvalidation } from "./CreateInvalidation.ts";

export const CreateInvalidationHttp = Layer.effect(
  CreateInvalidation,
  makeDistributionScopedHttpBinding({
    tag: "AWS.CloudFront.CreateInvalidation",
    operation: cloudfront.createInvalidation,
    actions: ["cloudfront:CreateInvalidation"],
  }),
);
