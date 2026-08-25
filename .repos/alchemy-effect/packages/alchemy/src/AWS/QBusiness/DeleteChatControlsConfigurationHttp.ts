import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { DeleteChatControlsConfiguration } from "./DeleteChatControlsConfiguration.ts";

export const DeleteChatControlsConfigurationHttp = Layer.effect(
  DeleteChatControlsConfiguration,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DeleteChatControlsConfiguration",
    operation: qbusiness.deleteChatControlsConfiguration,
    actions: ["qbusiness:DeleteChatControlsConfiguration"],
  }),
);
