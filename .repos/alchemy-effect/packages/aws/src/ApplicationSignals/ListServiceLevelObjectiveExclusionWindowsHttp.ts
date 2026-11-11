import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Layer from "effect/Layer";
import { makeSloIdHttpBinding } from "./BindingHttp.ts";
import { ListServiceLevelObjectiveExclusionWindows } from "./ListServiceLevelObjectiveExclusionWindows.ts";

export const ListServiceLevelObjectiveExclusionWindowsHttp = Layer.effect(
  ListServiceLevelObjectiveExclusionWindows,
  makeSloIdHttpBinding({
    tag: "AWS.ApplicationSignals.ListServiceLevelObjectiveExclusionWindows",
    operation: appsignals.listServiceLevelObjectiveExclusionWindows,
    actions: ["application-signals:ListServiceLevelObjectiveExclusionWindows"],
  }),
);
