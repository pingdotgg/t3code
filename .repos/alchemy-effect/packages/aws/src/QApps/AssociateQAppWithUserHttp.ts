import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { AssociateQAppWithUser } from "./AssociateQAppWithUser.ts";
import { makeQAppHttpBinding } from "./BindingHttp.ts";

export const AssociateQAppWithUserHttp = Layer.effect(
  AssociateQAppWithUser,
  makeQAppHttpBinding({
    capability: "AssociateQAppWithUser",
    iamActions: ["qapps:AssociateQAppWithUser"],
    operation: qapps.associateQAppWithUser,
    injectAppId: true,
  }),
);
