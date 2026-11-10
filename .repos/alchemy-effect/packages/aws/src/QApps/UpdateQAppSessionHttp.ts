import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { UpdateQAppSession } from "./UpdateQAppSession.ts";

export const UpdateQAppSessionHttp = Layer.effect(
  UpdateQAppSession,
  makeQAppHttpBinding({
    capability: "UpdateQAppSession",
    iamActions: ["qapps:UpdateQAppSession"],
    operation: qapps.updateQAppSession,
  }),
);
