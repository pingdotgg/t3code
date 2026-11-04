import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganization } from "./DescribeOrganization.ts";

export const DescribeOrganizationHttp = Layer.effect(
  DescribeOrganization,
  makeOrganizationsHttpBinding({
    capability: "DescribeOrganization",
    iamActions: ["organizations:DescribeOrganization"],
    operation: organizations.describeOrganization,
  }),
);
