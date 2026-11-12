import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { StopQAppSession } from "./StopQAppSession.ts";

export const StopQAppSessionHttp = Layer.effect(
  StopQAppSession,
  makeQAppHttpBinding({
    capability: "StopQAppSession",
    iamActions: ["qapps:StopQAppSession"],
    operation: qapps.stopQAppSession,
  }),
);
