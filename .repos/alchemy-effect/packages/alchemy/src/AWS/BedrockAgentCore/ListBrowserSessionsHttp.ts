import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListBrowserSessions } from "./ListBrowserSessions.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";

export const ListBrowserSessionsHttp = Layer.effect(
  ListBrowserSessions,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListBrowserSessions",
    operation: agentcore.listBrowserSessions,
    actions: ["bedrock-agentcore:ListBrowserSessions"],
    requestKey: "browserIdentifier",
    identifier: (browser: BrowserCustom) => browser.browserId,
    arns: (browser: BrowserCustom) => [browser.browserArn],
  }),
);
