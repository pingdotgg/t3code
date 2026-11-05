import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeOrganizationResourceCollectionHealth } from "./DescribeOrganizationResourceCollectionHealth.ts";

export const DescribeOrganizationResourceCollectionHealthHttp = Layer.effect(
  DescribeOrganizationResourceCollectionHealth,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealth",
    operation: devopsguru.describeOrganizationResourceCollectionHealth,
    actions: ["devops-guru:DescribeOrganizationResourceCollectionHealth"],
  }),
);
