import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";
import { ListAlerts } from "./ListAlerts.ts";

export const ListAlertsHttp = Layer.effect(
  ListAlerts,
  makeMediaTailorHttpBinding({
    capability: "ListAlerts",
    iamActions: ["mediatailor:ListAlerts"],
    operation: mediatailor.listAlerts,
  }),
);
