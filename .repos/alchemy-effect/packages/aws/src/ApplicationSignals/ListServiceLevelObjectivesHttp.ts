import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";
import { ListServiceLevelObjectives } from "./ListServiceLevelObjectives.ts";

export const ListServiceLevelObjectivesHttp = Layer.effect(
  ListServiceLevelObjectives,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceLevelObjectives",
    operation: appsignals.listServiceLevelObjectives,
    actions: ["application-signals:ListServiceLevelObjectives"],
  }),
);
