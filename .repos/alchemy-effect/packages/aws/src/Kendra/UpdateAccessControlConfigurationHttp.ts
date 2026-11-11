import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { UpdateAccessControlConfiguration } from "./UpdateAccessControlConfiguration.ts";

export const UpdateAccessControlConfigurationHttp = Layer.effect(
  UpdateAccessControlConfiguration,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.UpdateAccessControlConfiguration",
    operation: kendra.updateAccessControlConfiguration,
    actions: ["kendra:UpdateAccessControlConfiguration"],
    subResources: ["access-control-configuration/*"],
  }),
);
