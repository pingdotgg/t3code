import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { DisassociateQAppFromUser } from "./DisassociateQAppFromUser.ts";

export const DisassociateQAppFromUserHttp = Layer.effect(
  DisassociateQAppFromUser,
  makeQAppHttpBinding({
    capability: "DisassociateQAppFromUser",
    iamActions: ["qapps:DisassociateQAppFromUser"],
    operation: qapps.disassociateQAppFromUser,
    injectAppId: true,
  }),
);
