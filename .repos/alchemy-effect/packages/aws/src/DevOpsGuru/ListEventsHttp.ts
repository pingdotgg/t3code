import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListEvents } from "./ListEvents.ts";

export const ListEventsHttp = Layer.effect(
  ListEvents,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListEvents",
    operation: devopsguru.listEvents,
    actions: ["devops-guru:ListEvents"],
  }),
);
