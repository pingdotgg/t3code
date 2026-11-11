import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { BatchUpdateSchedule } from "./BatchUpdateSchedule.ts";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";

export const BatchUpdateScheduleHttp = Layer.effect(
  BatchUpdateSchedule,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.BatchUpdateSchedule",
    operation: medialive.batchUpdateSchedule,
    actions: ["medialive:BatchUpdateSchedule"],
  }),
);
