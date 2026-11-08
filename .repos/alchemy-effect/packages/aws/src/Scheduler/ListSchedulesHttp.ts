import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleGroupScopedHttpBinding } from "./BindingHttp.ts";
import { ListSchedules } from "./ListSchedules.ts";

export const ListSchedulesHttp = Layer.effect(
  ListSchedules,
  makeScheduleGroupScopedHttpBinding({
    tag: "AWS.Scheduler.ListSchedules",
    operation: scheduler.listSchedules,
    actions: ["scheduler:ListSchedules"],
    // An absent GroupName on ListSchedules means "all groups" — pin the
    // default group so listing stays inside the bound group by default.
    fallbackGroupName: "default",
    // IAM evaluates scheduler:ListSchedules against the account-wide
    // schedule/*/* pattern, so a group-scoped grant can never authorize it.
    resourceScope: "all",
  }),
);
