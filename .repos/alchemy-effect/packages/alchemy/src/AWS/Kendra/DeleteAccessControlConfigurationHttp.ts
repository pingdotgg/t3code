import * as kendra from "@distilled.cloud/aws/kendra";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import { DeleteAccessControlConfiguration } from "./DeleteAccessControlConfiguration.ts";

export const DeleteAccessControlConfigurationHttp = Layer.effect(
  DeleteAccessControlConfiguration,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.DeleteAccessControlConfiguration",
    operation: kendra.deleteAccessControlConfiguration,
    actions: ["kendra:DeleteAccessControlConfiguration"],
    subResources: ["access-control-configuration/*"],
  }),
);
