import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { GetBrowserSession } from "./GetBrowserSession.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export const GetBrowserSessionHttp = Layer.effect(
  GetBrowserSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetBrowserSession",
    operation: agentcore.getBrowserSession,
    actions: ["bedrock-agentcore:GetBrowserSession"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
