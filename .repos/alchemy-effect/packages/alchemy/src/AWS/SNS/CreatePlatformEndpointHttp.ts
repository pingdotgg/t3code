import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { CreatePlatformEndpoint } from "./CreatePlatformEndpoint.ts";

export const CreatePlatformEndpointHttp = Layer.effect(
  CreatePlatformEndpoint,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.CreatePlatformEndpoint",
    operation: sns.createPlatformEndpoint,
    actions: ["sns:CreatePlatformEndpoint"],
  }),
);
