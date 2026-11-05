import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeResourceCollectionHealth } from "./DescribeResourceCollectionHealth.ts";

export const DescribeResourceCollectionHealthHttp = Layer.effect(
  DescribeResourceCollectionHealth,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.DescribeResourceCollectionHealth",
    operation: devopsguru.describeResourceCollectionHealth,
    actions: ["devops-guru:DescribeResourceCollectionHealth"],
  }),
);
