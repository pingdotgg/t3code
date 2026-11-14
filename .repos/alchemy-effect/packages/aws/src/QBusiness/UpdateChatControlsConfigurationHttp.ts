import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { UpdateChatControlsConfiguration } from "./UpdateChatControlsConfiguration.ts";

export const UpdateChatControlsConfigurationHttp = Layer.effect(
  UpdateChatControlsConfiguration,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.UpdateChatControlsConfiguration",
    operation: qbusiness.updateChatControlsConfiguration,
    actions: ["qbusiness:UpdateChatControlsConfiguration"],
  }),
);
