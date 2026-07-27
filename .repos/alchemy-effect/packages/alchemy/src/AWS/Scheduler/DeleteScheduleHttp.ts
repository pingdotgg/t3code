import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleGroupScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteSchedule } from "./DeleteSchedule.ts";

export const DeleteScheduleHttp = Layer.effect(
  DeleteSchedule,
  makeScheduleGroupScopedHttpBinding({
    tag: "AWS.Scheduler.DeleteSchedule",
    operation: scheduler.deleteSchedule,
    actions: ["scheduler:DeleteSchedule"],
  }),
);
