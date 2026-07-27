import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetPasswordData } from "./GetPasswordData.ts";

export const GetPasswordDataHttp = Layer.effect(
  GetPasswordData,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.GetPasswordData",
    operation: ec2.getPasswordData,
    actions: ["ec2:GetPasswordData"],
    requestKey: "InstanceId",
  }),
);
