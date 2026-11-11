import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationHealth } from "./DescribeOrganizationHealth.ts";

export const DescribeOrganizationHealthHttp = Layer.effect(
  DescribeOrganizationHealth,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeOrganizationHealth",
    operation: devopsguru.describeOrganizationHealth,
    actions: ["devops-guru:DescribeOrganizationHealth"],
  }),
);
