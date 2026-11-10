import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { ExportQAppSessionData } from "./ExportQAppSessionData.ts";

export const ExportQAppSessionDataHttp = Layer.effect(
  ExportQAppSessionData,
  makeQAppHttpBinding({
    capability: "ExportQAppSessionData",
    iamActions: ["qapps:ExportQAppSessionData"],
    operation: qapps.exportQAppSessionData,
  }),
);
