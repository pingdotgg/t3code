import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleWriteHttpBinding } from "./BindingHttp.ts";
import { CreateSchedule } from "./CreateSchedule.ts";

export const CreateScheduleHttp = Layer.effect(
  CreateSchedule,
  makeScheduleWriteHttpBinding({
    tag: "AWS.Scheduler.CreateSchedule",
    operation: scheduler.createSchedule,
    actions: ["scheduler:CreateSchedule"],
  }),
);
