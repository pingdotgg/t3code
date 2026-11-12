import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { DeleteSchedule } from "./DeleteSchedule.ts";

export const DeleteScheduleHttp = Layer.effect(
  DeleteSchedule,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.DeleteSchedule",
    operation: medialive.deleteSchedule,
    actions: ["medialive:DeleteSchedule"],
  }),
);
