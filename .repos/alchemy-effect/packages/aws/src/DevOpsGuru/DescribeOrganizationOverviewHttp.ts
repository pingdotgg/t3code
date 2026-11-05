import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationOverview } from "./DescribeOrganizationOverview.ts";

export const DescribeOrganizationOverviewHttp = Layer.effect(
  DescribeOrganizationOverview,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeOrganizationOverview",
    operation: devopsguru.describeOrganizationOverview,
    actions: ["devops-guru:DescribeOrganizationOverview"],
  }),
);
