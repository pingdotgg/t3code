import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeSecurityGroupHttpBinding } from "./BindingHttp.ts";
import { RevokeSecurityGroupIngress } from "./RevokeSecurityGroupIngress.ts";

export const RevokeSecurityGroupIngressHttp = Layer.effect(
  RevokeSecurityGroupIngress,
  makeSecurityGroupHttpBinding({
    tag: "AWS.EC2.RevokeSecurityGroupIngress",
    operation: ec2.revokeSecurityGroupIngress,
    actions: ["ec2:RevokeSecurityGroupIngress"],
  }),
);
