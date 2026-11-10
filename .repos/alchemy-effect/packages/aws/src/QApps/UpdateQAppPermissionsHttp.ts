import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { UpdateQAppPermissions } from "./UpdateQAppPermissions.ts";

export const UpdateQAppPermissionsHttp = Layer.effect(
  UpdateQAppPermissions,
  makeQAppHttpBinding({
    capability: "UpdateQAppPermissions",
    iamActions: ["qapps:UpdateQAppPermissions"],
    operation: qapps.updateQAppPermissions,
    injectAppId: true,
  }),
);
