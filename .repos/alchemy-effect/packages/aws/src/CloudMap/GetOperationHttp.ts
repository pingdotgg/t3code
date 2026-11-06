import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapAccountHttpBinding } from "./BindingHttp.ts";
import { GetOperation } from "./GetOperation.ts";

export const GetOperationHttp = Layer.effect(
  GetOperation,
  makeCloudMapAccountHttpBinding({
    tag: "AWS.CloudMap.GetOperation",
    operation: SD.getOperation,
    // GetOperation does not support resource-level IAM permissions.
    actions: ["servicediscovery:GetOperation"],
  }),
);
