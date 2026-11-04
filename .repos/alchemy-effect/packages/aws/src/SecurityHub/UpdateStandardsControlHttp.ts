import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { UpdateStandardsControl } from "./UpdateStandardsControl.ts";

export const UpdateStandardsControlHttp = Layer.effect(
  UpdateStandardsControl,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.UpdateStandardsControl",
    operation: securityhub.updateStandardsControl,
    actions: ["securityhub:UpdateStandardsControl"],
  }),
);
