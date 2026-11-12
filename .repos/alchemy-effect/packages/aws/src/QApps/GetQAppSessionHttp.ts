import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { GetQAppSession } from "./GetQAppSession.ts";

export const GetQAppSessionHttp = Layer.effect(
  GetQAppSession,
  makeQAppHttpBinding({
    capability: "GetQAppSession",
    iamActions: ["qapps:GetQAppSession"],
    operation: qapps.getQAppSession,
  }),
);
