import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { PutNotificationChannel } from "./PutNotificationChannel.ts";

export const PutNotificationChannelHttp = Layer.effect(
  PutNotificationChannel,
  makeFmsHttpBinding({
    capability: "PutNotificationChannel",
    iamActions: ["fms:PutNotificationChannel"],
    operation: fms.putNotificationChannel,
  }),
);
