import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListEntityEvents } from "./ListEntityEvents.ts";

export const ListEntityEventsHttp = Layer.effect(
  ListEntityEvents,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListEntityEvents",
    operation: appsignals.listEntityEvents,
    actions: ["application-signals:ListEntityEvents"],
  }),
);
