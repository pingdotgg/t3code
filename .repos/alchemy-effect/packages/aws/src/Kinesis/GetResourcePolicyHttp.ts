import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Layer from "effect/Layer";
import { makeStreamHttpBinding } from "./BindingHttp.ts";
import { GetResourcePolicy } from "./GetResourcePolicy.ts";

export const GetResourcePolicyHttp = Layer.effect(
  GetResourcePolicy,
  makeStreamHttpBinding({
    tag: "AWS.Kinesis.GetResourcePolicy",
    operation: Kinesis.getResourcePolicy,
    actions: ["kinesis:GetResourcePolicy"],
    key: "ResourceARN",
  }),
);
