import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAccountOverview } from "./DescribeAccountOverview.ts";

export const DescribeAccountOverviewHttp = Layer.effect(
  DescribeAccountOverview,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeAccountOverview",
    operation: devopsguru.describeAccountOverview,
    actions: ["devops-guru:DescribeAccountOverview"],
  }),
);
