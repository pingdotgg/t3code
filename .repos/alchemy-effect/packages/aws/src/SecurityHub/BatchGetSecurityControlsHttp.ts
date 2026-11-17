import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { BatchGetSecurityControls } from "./BatchGetSecurityControls.ts";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";

export const BatchGetSecurityControlsHttp = Layer.effect(
  BatchGetSecurityControls,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchGetSecurityControls",
    operation: securityhub.batchGetSecurityControls,
    actions: ["securityhub:BatchGetSecurityControls"],
  }),
);
