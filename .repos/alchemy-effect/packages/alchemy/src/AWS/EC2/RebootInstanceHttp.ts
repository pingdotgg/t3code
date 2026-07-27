import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { RebootInstance } from "./RebootInstance.ts";

export const RebootInstanceHttp = Layer.effect(
  RebootInstance,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.RebootInstance",
    operation: ec2.rebootInstances,
    actions: ["ec2:RebootInstances"],
    requestKey: "InstanceIds",
  }),
);
