import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { GetChatControlsConfiguration } from "./GetChatControlsConfiguration.ts";

export const GetChatControlsConfigurationHttp = Layer.effect(
  GetChatControlsConfiguration,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.GetChatControlsConfiguration",
    operation: qbusiness.getChatControlsConfiguration,
    actions: ["qbusiness:GetChatControlsConfiguration"],
  }),
);
