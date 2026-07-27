import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { StartInstance } from "./StartInstance.ts";

export const StartInstanceHttp = Layer.effect(
  StartInstance,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.StartInstance",
    operation: ec2.startInstances,
    actions: ["ec2:StartInstances"],
    requestKey: "InstanceIds",
  }),
);
