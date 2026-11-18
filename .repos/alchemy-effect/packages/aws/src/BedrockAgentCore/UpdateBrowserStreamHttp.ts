import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";
import { UpdateBrowserStream } from "./UpdateBrowserStream.ts";

export const UpdateBrowserStreamHttp = Layer.effect(
  UpdateBrowserStream,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.UpdateBrowserStream",
    operation: agentcore.updateBrowserStream,
    actions: ["bedrock-agentcore:UpdateBrowserStream"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
