import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { DescribeProducts } from "./DescribeProducts.ts";

export const DescribeProductsHttp = Layer.effect(
  DescribeProducts,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.DescribeProducts",
    operation: securityhub.describeProducts,
    actions: ["securityhub:DescribeProducts"],
  }),
);
