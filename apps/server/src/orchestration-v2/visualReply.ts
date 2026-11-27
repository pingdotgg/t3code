import type { OrchestrationMessageContext } from "@t3tools/contracts";

import { isSlashCommandMessage } from "./ContextHandoffDelivery.ts";
import { isProviderCommand } from "./runOutput.ts";

const VISUAL_REPLY_INSTRUCTIONS =
  "Answer this message visually. Read `openui_guide` if you have not, explain the answer in an OpenUI program, check it with `html_preview`, and publish it with `html_render`. Use HTML where OpenUI cannot express it. If those tools are missing or fail, answer in text and say why.";

/** The provider's copy of a message's text, asking for a visual when the sender turned that on. */
export const withVisualReplyInstructions = (
  message: {
    readonly role: string;
    readonly text: string;
    readonly attachments?: ReadonlyArray<unknown> | undefined;
    readonly context?: OrchestrationMessageContext | undefined;
  },
  providerText: string,
): string =>
  message.context?.visualReply !== true ||
  isSlashCommandMessage(message) ||
  isProviderCommand(message)
    ? providerText
    : `${providerText}\n\n${VISUAL_REPLY_INSTRUCTIONS}`;
