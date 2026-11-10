import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAccountHealth } from "./DescribeAccountHealth.ts";

export const DescribeAccountHealthHttp = Layer.effect(
  DescribeAccountHealth,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeAccountHealth",
    operation: devopsguru.describeAccountHealth,
    actions: ["devops-guru:DescribeAccountHealth"],
  }),
);
