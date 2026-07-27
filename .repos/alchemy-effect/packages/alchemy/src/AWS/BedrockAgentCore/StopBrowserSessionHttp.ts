import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { StopBrowserSession } from "./StopBrowserSession.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export const StopBrowserSessionHttp = Layer.effect(
  StopBrowserSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.StopBrowserSession",
    operation: agentcore.stopBrowserSession,
    actions: ["bedrock-agentcore:StopBrowserSession"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
