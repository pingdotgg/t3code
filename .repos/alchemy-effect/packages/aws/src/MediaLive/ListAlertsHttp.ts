import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { ListAlerts } from "./ListAlerts.ts";

export const ListAlertsHttp = Layer.effect(
  ListAlerts,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.ListAlerts",
    operation: medialive.listAlerts,
    actions: ["medialive:ListAlerts"],
  }),
);
