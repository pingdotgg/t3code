import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Layer from "effect/Layer";
import { makeSecurityHubHttpBinding } from "./BindingHttp.ts";
import { BatchGetSecurityControls } from "./BatchGetSecurityControls.ts";

export const BatchGetSecurityControlsHttp = Layer.effect(
  BatchGetSecurityControls,
  makeSecurityHubHttpBinding({
    tag: "AWS.SecurityHub.BatchGetSecurityControls",
    operation: securityhub.batchGetSecurityControls,
    actions: ["securityhub:BatchGetSecurityControls"],
  }),
);
