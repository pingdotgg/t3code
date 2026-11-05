import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { DescribeHandshake } from "./DescribeHandshake.ts";

export const DescribeHandshakeHttp = Layer.effect(
  DescribeHandshake,
  makeOrganizationsHttpBinding({
    capability: "DescribeHandshake",
    iamActions: ["organizations:DescribeHandshake"],
    operation: organizations.describeHandshake,
  }),
);
