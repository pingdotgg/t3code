import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { AuthorizeSecurityGroupIngress } from "./AuthorizeSecurityGroupIngress.ts";
import { makeSecurityGroupHttpBinding } from "./BindingHttp.ts";

export const AuthorizeSecurityGroupIngressHttp = Layer.effect(
  AuthorizeSecurityGroupIngress,
  makeSecurityGroupHttpBinding({
    tag: "AWS.EC2.AuthorizeSecurityGroupIngress",
    operation: ec2.authorizeSecurityGroupIngress,
    actions: ["ec2:AuthorizeSecurityGroupIngress"],
  }),
);
