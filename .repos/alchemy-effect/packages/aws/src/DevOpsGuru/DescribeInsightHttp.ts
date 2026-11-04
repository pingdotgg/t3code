import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeInsight } from "./DescribeInsight.ts";

export const DescribeInsightHttp = Layer.effect(
  DescribeInsight,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeInsight",
    operation: devopsguru.describeInsight,
    actions: ["devops-guru:DescribeInsight"],
  }),
);
