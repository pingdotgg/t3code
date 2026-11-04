import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { GetSupportedResourceTypes } from "./GetSupportedResourceTypes.ts";

export const GetSupportedResourceTypesHttp = Layer.effect(
  GetSupportedResourceTypes,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.GetSupportedResourceTypes",
    operation: backup.getSupportedResourceTypes,
    actions: ["backup:GetSupportedResourceTypes"],
  }),
);
