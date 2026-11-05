import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { ListQAppSessionData } from "./ListQAppSessionData.ts";

export const ListQAppSessionDataHttp = Layer.effect(
  ListQAppSessionData,
  makeQAppHttpBinding({
    capability: "ListQAppSessionData",
    iamActions: ["qapps:ListQAppSessionData"],
    operation: qapps.listQAppSessionData,
  }),
);
