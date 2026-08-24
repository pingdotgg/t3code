import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleGroupScopedHttpBinding } from "./BindingHttp.ts";
import { GetSchedule } from "./GetSchedule.ts";

export const GetScheduleHttp = Layer.effect(
  GetSchedule,
  makeScheduleGroupScopedHttpBinding({
    tag: "AWS.Scheduler.GetSchedule",
    operation: scheduler.getSchedule,
    actions: ["scheduler:GetSchedule"],
  }),
);
