import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { SaveBrowserSessionProfile } from "./SaveBrowserSessionProfile.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export const SaveBrowserSessionProfileHttp = Layer.effect(
  SaveBrowserSessionProfile,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.SaveBrowserSessionProfile",
    operation: agentcore.saveBrowserSessionProfile,
    actions: ["bedrock-agentcore:SaveBrowserSessionProfile"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
