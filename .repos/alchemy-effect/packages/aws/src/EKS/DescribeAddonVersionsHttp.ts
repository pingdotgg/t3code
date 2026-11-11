import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAddonVersions } from "./DescribeAddonVersions.ts";

export const DescribeAddonVersionsHttp = Layer.effect(
  DescribeAddonVersions,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.DescribeAddonVersions",
    operation: eks.describeAddonVersions,
    actions: ["eks:DescribeAddonVersions"],
  }),
);
