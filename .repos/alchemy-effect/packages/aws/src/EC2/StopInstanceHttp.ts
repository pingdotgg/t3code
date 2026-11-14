import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StopInstance } from "./StopInstance.ts";

export const StopInstanceHttp = Layer.effect(
  StopInstance,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.StopInstance",
    operation: ec2.stopInstances,
    actions: ["ec2:StopInstances"],
    requestKey: "InstanceIds",
  }),
);
