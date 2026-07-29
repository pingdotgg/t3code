import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetNotificationChannel } from "./GetNotificationChannel.ts";

export const GetNotificationChannelHttp = Layer.effect(
  GetNotificationChannel,
  makeFmsHttpBinding({
    capability: "GetNotificationChannel",
    iamActions: ["fms:GetNotificationChannel"],
    operation: fms.getNotificationChannel,
  }),
);
