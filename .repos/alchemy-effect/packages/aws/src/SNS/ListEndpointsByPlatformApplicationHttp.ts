import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsPlatformHttpBinding } from "./BindingHttp.ts";
import { ListEndpointsByPlatformApplication } from "./ListEndpointsByPlatformApplication.ts";

export const ListEndpointsByPlatformApplicationHttp = Layer.effect(
  ListEndpointsByPlatformApplication,
  makeSnsPlatformHttpBinding({
    tag: "AWS.SNS.ListEndpointsByPlatformApplication",
    operation: sns.listEndpointsByPlatformApplication,
    actions: ["sns:ListEndpointsByPlatformApplication"],
  }),
);
