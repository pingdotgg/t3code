import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetConsoleOutput } from "./GetConsoleOutput.ts";

export const GetConsoleOutputHttp = Layer.effect(
  GetConsoleOutput,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.GetConsoleOutput",
    operation: ec2.getConsoleOutput,
    actions: ["ec2:GetConsoleOutput"],
    requestKey: "InstanceId",
  }),
);
