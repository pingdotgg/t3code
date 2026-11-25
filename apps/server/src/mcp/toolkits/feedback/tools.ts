import { OrchestratorMcpFailure } from "@lathe/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import {
  FeedbackAwaitingApproval,
  FeedbackInput,
  FeedbackSubmitResult,
} from "../../../feedback/FeedbackReport.ts";
import * as Feedback from "../../../feedback/FeedbackService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Feedback.FeedbackService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

export const FeedbackToolkit = Toolkit.make(
  Tool.make("lathe_feedback", {
    ...shared,
    description:
      "Send feedback to the Lathe team: a Lathe tool or `lathe` command that misbehaved, a confusing instruction, a missing capability, or anything about Lathe the user asks you to send. Not the user's own code. Use your own words; never quote the user's messages, code, files, or names. A report the user asks for opens a card where they approve it and choose whether to include the conversation of the `turns` you set, so call this when asked without asking first, and never paste the conversation into it.",
    parameters: FeedbackInput,
    success: Schema.Union([FeedbackSubmitResult, FeedbackAwaitingApproval]),
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileFeedbackOff),
);
