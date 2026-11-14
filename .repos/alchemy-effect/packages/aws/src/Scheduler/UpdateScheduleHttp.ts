import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleWriteHttpBinding } from "./BindingHttp.ts";
import { UpdateSchedule } from "./UpdateSchedule.ts";

export const UpdateScheduleHttp = Layer.effect(
  UpdateSchedule,
  makeScheduleWriteHttpBinding({
    tag: "AWS.Scheduler.UpdateSchedule",
    operation: scheduler.updateSchedule,
    actions: ["scheduler:UpdateSchedule"],
  }),
);
