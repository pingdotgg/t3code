import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAddonConfiguration } from "./DescribeAddonConfiguration.ts";

export const DescribeAddonConfigurationHttp = Layer.effect(
  DescribeAddonConfiguration,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.DescribeAddonConfiguration",
    operation: eks.describeAddonConfiguration,
    actions: ["eks:DescribeAddonConfiguration"],
  }),
);
