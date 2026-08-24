import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { DetectStackDrift } from "./DetectStackDrift.ts";

export const DetectStackDriftHttp = Layer.effect(
  DetectStackDrift,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.DetectStackDrift",
    operation: cloudformation.detectStackDrift,
    // DetectStackDrift authorizes BOTH actions on the stack — the per-stack
    // call fans out to per-resource drift checks and AWS rejects the call
    // with AccessDenied on cloudformation:DetectStackResourceDrift alone.
    actions: [
      "cloudformation:DetectStackDrift",
      "cloudformation:DetectStackResourceDrift",
    ],
  }),
);
