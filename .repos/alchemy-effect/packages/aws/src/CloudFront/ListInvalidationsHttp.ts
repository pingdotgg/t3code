import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Layer from "effect/Layer";
import { makeDistributionScopedHttpBinding } from "./BindingHttp.ts";
import { ListInvalidations } from "./ListInvalidations.ts";

export const ListInvalidationsHttp = Layer.effect(
  ListInvalidations,
  makeDistributionScopedHttpBinding({
    tag: "AWS.CloudFront.ListInvalidations",
    operation: cloudfront.listInvalidations,
    actions: ["cloudfront:ListInvalidations"],
  }),
);
