import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { InvokeBrowser } from "./InvokeBrowser.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export const InvokeBrowserHttp = Layer.effect(
  InvokeBrowser,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeBrowser",
    operation: agentcore.invokeBrowser,
    actions: ["bedrock-agentcore:InvokeBrowser"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
