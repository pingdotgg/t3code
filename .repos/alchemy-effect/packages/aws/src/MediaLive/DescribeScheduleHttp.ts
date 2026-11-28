import * as medialive from "@distilled.cloud/aws/medialive";
import * as Layer from "effect/Layer";
import { makeMediaLiveChannelHttpBinding } from "./BindingHttp.ts";
import { DescribeSchedule } from "./DescribeSchedule.ts";

export const DescribeScheduleHttp = Layer.effect(
  DescribeSchedule,
  makeMediaLiveChannelHttpBinding({
    tag: "AWS.MediaLive.DescribeSchedule",
    operation: medialive.describeSchedule,
    actions: ["medialive:DescribeSchedule"],
  }),
);
