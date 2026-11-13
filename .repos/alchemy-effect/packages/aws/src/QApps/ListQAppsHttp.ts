import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import { ListQApps } from "./ListQApps.ts";

export const ListQAppsHttp = Layer.effect(
  ListQApps,
  makeQAppsInstanceHttpBinding({
    capability: "ListQApps",
    iamActions: ["qapps:ListQApps"],
    operation: qapps.listQApps,
  }),
);
