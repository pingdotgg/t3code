import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryServiceAccountHttpBinding } from "./BindingHttp.ts";
import { GetDirectoryLimits } from "./GetDirectoryLimits.ts";

export const GetDirectoryLimitsHttp = Layer.effect(
  GetDirectoryLimits,
  makeDirectoryServiceAccountHttpBinding({
    tag: "AWS.DirectoryService.GetDirectoryLimits",
    operation: ds.getDirectoryLimits,
    actions: ["ds:GetDirectoryLimits"],
  }),
);
