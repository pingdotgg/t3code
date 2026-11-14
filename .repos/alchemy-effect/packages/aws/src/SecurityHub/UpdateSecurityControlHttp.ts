import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { UpdateSecurityControl } from "./UpdateSecurityControl.ts";

export const UpdateSecurityControlHttp = Layer.effect(
  UpdateSecurityControl,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.UpdateSecurityControl",
    operation: securityhub.updateSecurityControl,
    actions: ["securityhub:UpdateSecurityControl"],
  }),
);
