import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import {
  FeedbackInput,
  FeedbackNotApproved,
  FeedbackReport,
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
  Tool.make("t3_feedback", {
    ...shared,
    description:
      "Send feedback to the T3 team: a T3 tool or `t3` command that misbehaved, a confusing instruction, a missing capability, or anything about T3 Code the user asks you to send. Not the user's own code. Use your own words; never quote the user's messages, code, files, or names. A requested report also carries an outline of recent turns, without text; set `includeTurns` only if the user asks to include the conversation. The user sees a requested report and approves it before it is sent, so call this when asked without asking first; the result says whether they approved.",
    parameters: FeedbackInput,
    success: Schema.Union([FeedbackSubmitResult, FeedbackNotApproved]),
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileFeedbackOff),
  Tool.make("t3_feedback_list", {
    ...shared,
    description: "List this machine's recent T3 Code feedback reports.",
    success: Schema.Struct({ reports: Schema.Array(FeedbackReport) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileFeedbackOff),
);
