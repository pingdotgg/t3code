import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { DescribeCreateAccountStatus } from "./DescribeCreateAccountStatus.ts";

export const DescribeCreateAccountStatusHttp = Layer.effect(
  DescribeCreateAccountStatus,
  makeOrganizationsHttpBinding({
    capability: "DescribeCreateAccountStatus",
    iamActions: ["organizations:DescribeCreateAccountStatus"],
    operation: organizations.describeCreateAccountStatus,
  }),
);
